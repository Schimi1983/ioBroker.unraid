"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MEMORY_SUBSCRIPTION = exports.CPU_SUBSCRIPTION = exports.METRICS_SUBSCRIPTION = exports.UnraidApolloClient = exports.CAPABILITY_PROBE_MUTATION = exports.CAPABILITY_PROBE_QUERY = void 0;
const core_1 = require("@apollo/client/core");
const subscriptions_1 = require("@apollo/client/link/subscriptions");
const utilities_1 = require("@apollo/client/utilities");
const graphql_ws_1 = require("graphql-ws");
const ws_1 = __importDefault(require("ws"));
const undici_1 = require("undici");
const capabilities_1 = require("./shared/capabilities");
/** Maximum duration of a polling query before it is aborted */
const QUERY_TIMEOUT_MS = 30_000;
/** Maximum duration of a control action (container updates pull images and can take minutes) */
const MUTATION_TIMEOUT_MS = 10 * 60_000;
/**
 * Probe for optional query fields. `$probe` is intentionally unused so the document
 * is rejected during validation and never executed.
 */
exports.CAPABILITY_PROBE_QUERY = `
    query UnraidCapabilityProbe($probe: Boolean) {
        metrics { temperature { id } }
        docker { containerUpdateStatuses { __typename } containers { isUpdateAvailable } }
    }
`;
/**
 * Probe for optional mutations. `$probe` is intentionally unused so the document
 * is rejected during validation and never executed.
 */
exports.CAPABILITY_PROBE_MUTATION = `
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
 * Apollo GraphQL client wrapper for Unraid server communication.
 * Handles both HTTP queries/mutations and WebSocket subscriptions.
 */
class UnraidApolloClient {
    /** Apollo Client instance for GraphQL operations */
    client;
    /** WebSocket client for subscription support */
    wsClient;
    /** Base URL of the Unraid server */
    baseUrl;
    /** API token for authentication */
    apiToken;
    /** Logger instance for structured logging */
    logger;
    /** fetch implementation used for HTTP requests (honours the self-signed setting) */
    fetchImpl;
    /** Shared dispatcher for self-signed HTTPS connections */
    selfSignedAgent;
    /**
     * Creates a new Unraid Apollo client instance
     *
     * @param options - Configuration options for the client
     */
    constructor(options) {
        this.baseUrl = options.baseUrl.replace(/\/$/, '');
        this.apiToken = options.apiToken;
        this.logger = options.logger;
        // Create custom fetch for self-signed certificates if needed.
        // Note: The dispatcher is created once and reused; creating a new undici Agent
        // per request (previous behaviour) opened a fresh connection pool on every poll.
        const selfSignedAgent = options.allowSelfSigned && this.baseUrl.startsWith('https://')
            ? new undici_1.Agent({ connect: { rejectUnauthorized: false } })
            : undefined;
        const customFetch = selfSignedAgent
            ? (url, init) => (0, undici_1.fetch)(url, { ...init, dispatcher: selfSignedAgent })
            : undefined;
        this.fetchImpl = (customFetch ?? globalThis.fetch);
        this.selfSignedAgent = selfSignedAgent;
        // Create WebSocket client for subscriptions
        const wsUrl = `${this.baseUrl.replace(/^http/, 'ws')}/graphql`;
        // Create a custom WebSocket class that includes our options
        class CustomWebSocket extends ws_1.default {
            constructor(url, protocols) {
                const wsOptions = {
                    rejectUnauthorized: !options.allowSelfSigned,
                    headers: {
                        'x-api-key': options.apiToken,
                    },
                };
                super(url, protocols, wsOptions);
            }
        }
        this.wsClient = (0, graphql_ws_1.createClient)({
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
        const httpLink = new core_1.HttpLink({
            uri: `${this.baseUrl}/graphql`,
            headers: {
                'x-api-key': this.apiToken,
            },
            fetch: customFetch,
        });
        // Create WebSocket link for subscriptions
        const wsLink = new subscriptions_1.GraphQLWsLink(this.wsClient);
        // Split link based on operation type
        const splitLink = (0, core_1.split)(({ query }) => {
            const definition = (0, utilities_1.getMainDefinition)(query);
            return definition.kind === 'OperationDefinition' && definition.operation === 'subscription';
        }, wsLink, httpLink);
        // Create Apollo Client
        this.client = new core_1.ApolloClient({
            link: splitLink,
            cache: new core_1.InMemoryCache(),
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
    async query(query) {
        const result = await this.client.query({
            query: (0, core_1.gql)(query),
            context: { fetchOptions: { signal: AbortSignal.timeout(QUERY_TIMEOUT_MS) } },
        });
        return result.data;
    }
    /**
     * Execute a GraphQL mutation against the Unraid server
     *
     * @param mutation - The GraphQL mutation string
     * @param variables - Optional variables for the mutation
     * @returns Promise resolving to the mutation result data
     * @template T - Type of the expected mutation result
     */
    async mutate(mutation, variables) {
        try {
            const result = await this.client.mutate({
                mutation: (0, core_1.gql)(mutation),
                variables,
                context: { fetchOptions: { signal: AbortSignal.timeout(MUTATION_TIMEOUT_MS) } },
            });
            return result.data;
        }
        catch (error) {
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
    subscribe(subscription, variables) {
        return this.client.subscribe({
            query: (0, core_1.gql)(subscription),
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
    async probeCapabilities() {
        try {
            const messages = [
                ...(await this.validateOnly(exports.CAPABILITY_PROBE_QUERY)),
                ...(await this.validateOnly(exports.CAPABILITY_PROBE_MUTATION)),
            ];
            if (!messages.some(m => m.includes('is never used'))) {
                // The server did not validate the probe as expected (e.g. auth error or proxy) — keep defaults.
                this.logger.debug(`Capability probe inconclusive: ${messages.join(' | ') || 'no errors returned'}`);
                return (0, capabilities_1.allCapabilitiesEnabled)();
            }
            const capabilities = (0, capabilities_1.capabilitiesFromValidationErrors)(messages);
            this.logger.debug(`Unraid capabilities: ${JSON.stringify(capabilities)}`);
            return capabilities;
        }
        catch (error) {
            this.logger.debug(`Capability probe failed, assuming all features are available: ${error instanceof Error ? error.message : String(error)}`);
            return (0, capabilities_1.allCapabilitiesEnabled)();
        }
    }
    /**
     * POST a GraphQL document and return the error messages of the response.
     * Used only for probe documents that are guaranteed to fail validation.
     *
     * @param document - GraphQL document
     * @returns Error messages reported by the server
     */
    async validateOnly(document) {
        const response = await this.fetchImpl(`${this.baseUrl}/graphql`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-api-key': this.apiToken },
            body: JSON.stringify({ query: document }),
            signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
        });
        const text = await response.text();
        try {
            const body = JSON.parse(text);
            return (body.errors ?? []).map(e => String(e.message ?? ''));
        }
        catch {
            return [`HTTP ${response.status}`];
        }
    }
    /**
     * Run an introspection query to discover available GraphQL subscriptions.
     * Useful for debugging and discovering the Unraid API schema.
     *
     * @returns Promise resolving to subscription type information or null if failed
     */
    async introspectSubscriptions() {
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
            const result = await this.query(introspectionQuery);
            return result?.__schema?.subscriptionType;
        }
        catch (error) {
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
    async dispose() {
        this.client.stop();
        await this.wsClient.dispose();
        await this.selfSignedAgent?.close();
    }
    /**
     * Check if the WebSocket connection is established
     *
     * @returns True if WebSocket client exists, false otherwise
     */
    isConnected() {
        // This is a simplified check - you might want to implement more sophisticated logic
        return this.wsClient !== null;
    }
}
exports.UnraidApolloClient = UnraidApolloClient;
/**
 * GraphQL subscription for comprehensive system metrics.
 * Includes both CPU and memory statistics.
 */
exports.METRICS_SUBSCRIPTION = `
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
exports.CPU_SUBSCRIPTION = `
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
exports.MEMORY_SUBSCRIPTION = `
    subscription MemorySubscription {
        memory {
            percentTotal
            total
            used
            free
        }
    }
`;
//# sourceMappingURL=apollo-client.js.map