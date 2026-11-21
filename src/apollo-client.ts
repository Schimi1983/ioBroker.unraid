import { ApolloClient, InMemoryCache, split, HttpLink, gql } from '@apollo/client/core';
import { GraphQLWsLink } from '@apollo/client/link/subscriptions';
import { getMainDefinition } from '@apollo/client/utilities';
import { createClient } from 'graphql-ws';
import type { ClientOptions } from 'ws';
import WebSocket from 'ws';
import { fetch, Agent } from 'undici';
import type { AdapterInterface } from './types/adapter-types';
import type { Capabilities } from './shared/capabilities';
import { allCapabilitiesEnabled, capabilitiesFromValidationErrors } from './shared/capabilities';

/** Maximum duration of a polling query before it is aborted */
const QUERY_TIMEOUT_MS = 30_000;
/** Maximum duration of a control action (container updates pull images and can take minutes) */
const MUTATION_TIMEOUT_MS = 10 * 60_000;

/**
 * Probe for optional query fields. `$probe` is intentionally unused so the document
 * is rejected during validation and never executed.
 */
export const CAPABILITY_PROBE_QUERY = `
    query UnraidCapabilityProbe($probe: Boolean) {
        metrics { temperature { id } }
        docker { containerUpdateStatuses { __typename } containers { isUpdateAvailable } }
    }
`;

/**
 * Probe for optional mutations. `$probe` is intentionally unused so the document
 * is rejected during validation and never executed.
 */
export const CAPABILITY_PROBE_MUTATION = `
    mutation UnraidCapabilityProbe($id: PrefixedID!, $probe: Boolean) {
        docker {
            pause(id: $id) { id }
            unpause(id: $id) { id }
            updateContainer(id: $id) { id }
            restart(id: $id) { id }
            updateAllContainers { id }
        }
    }
`;

/**
 * Configuration options for the Unraid Apollo GraphQL client
 */
export interface ApolloClientOptions {
    /** Base URL of the Unraid server (e.g., https://192.168.1.100) */
    baseUrl: string;
    /** API token for authentication with Unraid */
    apiToken: string;
    /** Whether to allow self-signed SSL certificates (default: false) */
    allowSelfSigned?: boolean;
    /** ioBroker adapter logger instance */
    logger: AdapterInterface['log'];
}

/**
 * Apollo GraphQL client wrapper for Unraid server communication.
 * Handles both HTTP queries/mutations and WebSocket subscriptions.
 */
export class UnraidApolloClient {
    /** Apollo Client instance for GraphQL operations */
    private client: ApolloClient;
    /** WebSocket client for subscription support */
    private wsClient: ReturnType<typeof createClient>;
    /** Base URL of the Unraid server */
    private readonly baseUrl: string;
    /** API token for authentication */
    private readonly apiToken: string;
    /** Logger instance for structured logging */
    private readonly logger: AdapterInterface['log'];
    /** fetch implementation used for HTTP requests (honours the self-signed setting) */
    private readonly fetchImpl: typeof globalThis.fetch;
    /** Shared dispatcher for self-signed HTTPS connections */
    private readonly selfSignedAgent?: Agent;

    /**
     * Creates a new Unraid Apollo client instance
     *
     * @param options - Configuration options for the client
     */
    constructor(options: ApolloClientOptions) {
        this.baseUrl = options.baseUrl.replace(/\/$/, '');
        this.apiToken = options.apiToken;
        this.logger = options.logger;

        // Create custom fetch for self-signed certificates if needed.
        // Note: The dispatcher is created once and reused; creating a new undici Agent
        // per request (previous behaviour) opened a fresh connection pool on every poll.
        const selfSignedAgent =
            options.allowSelfSigned && this.baseUrl.startsWith('https://')
                ? new Agent({ connect: { rejectUnauthorized: false } })
                : undefined;
        const customFetch = selfSignedAgent
            ? (url: any, init?: any): any => fetch(url, { ...init, dispatcher: selfSignedAgent })
            : undefined;
        this.fetchImpl = (customFetch ?? globalThis.fetch) as typeof globalThis.fetch;
        this.selfSignedAgent = selfSignedAgent;

        // Create WebSocket client for subscriptions
        const wsUrl = `${this.baseUrl.replace(/^http/, 'ws')}/graphql`;

        // Create a custom WebSocket class that includes our options
        class CustomWebSocket extends WebSocket {
            constructor(url: string | URL, protocols?: string | string[]) {
                const wsOptions: ClientOptions = {
                    rejectUnauthorized: !options.allowSelfSigned,
                    headers: {
                        'x-api-key': options.apiToken,
                    },
                };
                super(url, protocols, wsOptions);
            }
        }

        this.wsClient = createClient({
            url: wsUrl,
            webSocketImpl: CustomWebSocket,
            connectionParams: {
                'x-api-key': this.apiToken,
            },
            retryAttempts: 5,
            shouldRetry: () => true,
            keepAlive: 30000,
        });

        // Create HTTP link for queries and mutations
        const httpLink = new HttpLink({
            uri: `${this.baseUrl}/graphql`,
            headers: {
                'x-api-key': this.apiToken,
            },
            fetch: customFetch,
        });

        // Create WebSocket link for subscriptions
        const wsLink = new GraphQLWsLink(this.wsClient);

        // Split link based on operation type
        const splitLink = split(
            ({ query }) => {
                const definition = getMainDefinition(query);
                return definition.kind === 'OperationDefinition' && definition.operation === 'subscription';
            },
            wsLink,
            httpLink,
        );

        // Create Apollo Client
        this.client = new ApolloClient({
            link: splitLink,
            cache: new InMemoryCache(),
            defaultOptions: {
                watchQuery: {
                    fetchPolicy: 'no-cache',
                },
                query: {
                    fetchPolicy: 'no-cache',
                },
            },
        });
    }

    /**
     * Execute a GraphQL query against the Unraid server
     *
     * @param query - The GraphQL query string
     * @returns Promise resolving to the query result data
     * @template T - Type of the expected query result
     */
    async query<T = unknown>(query: string): Promise<T> {
        const result = await this.client.query<T>({
            query: gql(query),
            context: { fetchOptions: { signal: AbortSignal.timeout(QUERY_TIMEOUT_MS) } },
        });
        return result.data as T;
    }

    /**
     * Execute a GraphQL mutation against the Unraid server
     *
     * @param mutation - The GraphQL mutation string
     * @param variables - Optional variables for the mutation
     * @returns Promise resolving to the mutation result data
     * @template T - Type of the expected mutation result
     */
    async mutate<T = unknown>(mutation: string, variables?: Record<string, unknown>): Promise<T> {
        try {
            const result = await this.client.mutate<T>({
                mutation: gql(mutation),
                variables,
                context: { fetchOptions: { signal: AbortSignal.timeout(MUTATION_TIMEOUT_MS) } },
            });
            return result.data as T;
        } catch (error: any) {
            // Log more details about GraphQL errors
            if (error.graphQLErrors?.length > 0) {
                this.logger.error(`GraphQL Errors in mutation: ${JSON.stringify(error.graphQLErrors, null, 2)}`);
            }
            if (error.networkError) {
                this.logger.error(`Network Error in mutation: ${error.networkError.message}`);
                if (error.networkError.result) {
                    this.logger.debug(`Server Response: ${JSON.stringify(error.networkError.result, null, 2)}`);
                }
            }
            throw error;
        }
    }

    /**
     * Subscribe to a GraphQL subscription for real-time updates
     *
     * @param subscription - The GraphQL subscription string
     * @param variables - Optional variables for the subscription
     * @returns Observable that emits subscription results
     * @template T - Type of the expected subscription result
     */
    subscribe<T = unknown>(
        subscription: string,
        variables?: Record<string, unknown>,
    ): ReturnType<typeof this.client.subscribe<T>> {
        return this.client.subscribe<T>({
            query: gql(subscription),
            variables,
        });
    }

    /**
     * Detect optional API features without GraphQL introspection.
     *
     * Note: Unraid blocks `__schema`/`__type` in production, so the previous
     * introspection probe always failed. Instead we send probe documents that contain an
     * unused variable: the server rejects them during validation (NoUnusedVariablesRule),
     * so nothing is executed (no disk access, no container action), and the same
     * validation run reports every field the schema does not know ("Cannot query field").
     *
     * @returns Promise resolving to detected capability flags (all enabled if the probe is inconclusive)
     */
    async probeCapabilities(): Promise<Capabilities> {
        try {
            const messages = [
                ...(await this.validateOnly(CAPABILITY_PROBE_QUERY)),
                ...(await this.validateOnly(CAPABILITY_PROBE_MUTATION)),
            ];
            if (!messages.some(m => m.includes('is never used'))) {
                // The server did not validate the probe as expected (e.g. auth error or proxy) — keep defaults.
                this.logger.debug(`Capability probe inconclusive: ${messages.join(' | ') || 'no errors returned'}`);
                return allCapabilitiesEnabled();
            }
            const capabilities = capabilitiesFromValidationErrors(messages);
            this.logger.debug(`Unraid capabilities: ${JSON.stringify(capabilities)}`);
            return capabilities;
        } catch (error) {
            this.logger.debug(
                `Capability probe failed, assuming all features are available: ${error instanceof Error ? error.message : String(error)}`,
            );
            return allCapabilitiesEnabled();
        }
    }

    /**
     * POST a GraphQL document and return the error messages of the response.
     * Used only for probe documents that are guaranteed to fail validation.
     *
     * @param document - GraphQL document
     * @returns Error messages reported by the server
     */
    private async validateOnly(document: string): Promise<string[]> {
        const response = await this.fetchImpl(`${this.baseUrl}/graphql`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-api-key': this.apiToken },
            body: JSON.stringify({ query: document }),
            signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
        });
        const text = await response.text();
        try {
            const body = JSON.parse(text) as { errors?: Array<{ message?: string }> };
            return (body.errors ?? []).map(e => String(e.message ?? ''));
        } catch {
            return [`HTTP ${response.status}`];
        }
    }

    /**
     * Run an introspection query to discover available GraphQL subscriptions.
     * Useful for debugging and discovering the Unraid API schema.
     *
     * @returns Promise resolving to subscription type information or null if failed
     */
    async introspectSubscriptions(): Promise<unknown> {
        const introspectionQuery = `
            query IntrospectionQuery {
                __schema {
                    subscriptionType {
                        name
                        fields {
                            name
                            description
                            args {
                                name
                                type {
                                    name
                                    kind
                                }
                            }
                            type {
                                name
                                kind
                            }
                        }
                    }
                }
            }
        `;

        try {
            const result = await this.query<{ __schema?: { subscriptionType?: unknown } }>(introspectionQuery);
            return result?.__schema?.subscriptionType;
        } catch (error) {
            this.logger.warn(`Failed to introspect subscriptions: ${error}`);
            return null;
        }
    }

    /**
     * Dispose the client and close all connections.
     * Should be called when the client is no longer needed.
     *
     * @returns Promise that resolves when cleanup is complete
     */
    async dispose(): Promise<void> {
        this.client.stop();
        await this.wsClient.dispose();
        await this.selfSignedAgent?.close();
    }

    /**
     * Check if the WebSocket connection is established
     *
     * @returns True if WebSocket client exists, false otherwise
     */
    isConnected(): boolean {
        // This is a simplified check - you might want to implement more sophisticated logic
        return this.wsClient !== null;
    }
}

/**
 * GraphQL subscription for comprehensive system metrics.
 * Includes both CPU and memory statistics.
 */
export const METRICS_SUBSCRIPTION = `
    subscription MetricsSubscription {
        metrics {
            cpu {
                percentTotal
            }
            memory {
                percentTotal
                total
                used
                free
            }
        }
    }
`;

/**
 * GraphQL subscription for CPU metrics only.
 * Returns the total CPU usage percentage.
 */
export const CPU_SUBSCRIPTION = `
    subscription CpuSubscription {
        cpu {
            percentTotal
        }
    }
`;

/**
 * GraphQL subscription for memory metrics.
 * Includes total, used, free memory and usage percentage.
 */
export const MEMORY_SUBSCRIPTION = `
    subscription MemorySubscription {
        memory {
            percentTotal
            total
            used
            free
        }
    }
`;
