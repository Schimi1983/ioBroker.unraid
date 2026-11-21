import type { AdapterInterface } from '../types/adapter-types';
import type { UnraidApolloClient } from '../apollo-client';
import type { DomainDefinition } from '../shared/unraid-domains';
import type { Capabilities, CapabilityKey } from '../shared/capabilities';
import { GraphQLSelectionBuilder } from '../graphql/selection-builder';

/**
 * Manages polling cycles and GraphQL queries
 */
export class PollingManager {
    private pollTimer?: ioBroker.Timeout;
    private stopRequested = false;
    private currentDefinitions: readonly DomainDefinition[] = [];
    private reportedMissingFields = new Set<string>();
    /** True while a poll request is running */
    private pollRunning = false;
    /** A poll was requested while another one was running */
    private pollPending = false;
    /** Last reported error (used to log repeated failures only once) */
    private lastError?: string;

    /**
     * Create a new polling manager
     *
     * @param adapter - Adapter interface for logging and timers
     * @param apolloClient - Apollo client for GraphQL queries
     * @param capabilities - Mutable capability flags; updated on runtime fallback
     * @param onDataReceived - Callback function when data is received
     * @param onConnectionChange - Callback with the result of every poll (true = server answered)
     */
    constructor(
        private readonly adapter: AdapterInterface,
        private readonly apolloClient: UnraidApolloClient,
        private readonly capabilities: Capabilities,
        private readonly onDataReceived: (data: Record<string, unknown>) => Promise<void>,
        private readonly onConnectionChange: (connected: boolean) => Promise<void> = async () => {},
    ) {}

    /**
     * Start polling with the given interval
     *
     * @param pollIntervalMs - Polling interval in milliseconds
     * @param definitions - Array of domain definitions to poll
     */
    start(pollIntervalMs: number, definitions: readonly DomainDefinition[]): void {
        if (this.stopRequested) {
            return;
        }

        this.currentDefinitions = definitions;

        // Execute first poll immediately
        void this.pollOnce(definitions).finally(() => {
            this.scheduleNextPoll(pollIntervalMs, definitions);
        });
    }

    /**
     * Trigger a manual poll (e.g., after a control action)
     */
    poll(): void {
        if (this.currentDefinitions.length === 0) {
            this.adapter.log.debug('Cannot poll - no definitions available');
            return;
        }

        void this.pollOnce(this.currentDefinitions);
    }

    /**
     * Stop polling
     */
    stop(): void {
        this.stopRequested = true;

        if (this.pollTimer) {
            this.adapter.clearTimeout(this.pollTimer);
            this.pollTimer = undefined;
        }
    }

    /**
     * Execute a single polling cycle. Never throws: errors are reported once via the log
     * and through `onConnectionChange(false)`.
     *
     * @param definitions - Array of domain definitions to poll
     */
    private async pollOnce(definitions: readonly DomainDefinition[]): Promise<void> {
        if (!definitions.length) {
            this.adapter.log.debug('Skipping poll because no domains are selected.');
            return;
        }
        if (this.pollRunning) {
            // Note: A control action triggers an extra poll; never run two requests in parallel
            this.pollPending = true;
            return;
        }

        const query = this.buildQuery(definitions);
        if (!query) {
            this.adapter.log.warn('No query could be built for the current selection.');
            return;
        }

        this.pollRunning = true;
        try {
            const data = await this.apolloClient.query<Record<string, unknown>>(query);
            this.logGraphQLResponse(data);
            await this.onConnectionChange(true);
            if (this.lastError) {
                this.adapter.log.info('Connection to the Unraid server restored.');
                this.lastError = undefined;
            }
            try {
                await this.onDataReceived(data);
            } catch (processingError) {
                // Server answered; a failure here is local (objects DB) and not a connection problem
                this.adapter.log.error(`Processing Unraid data failed: ${this.describeError(processingError)}`);
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            // Handle "Cannot query field X on type Y" by disabling the related capability
            // and deferring a rebuilt query to the next poll cycle. Existing states are
            // preserved — no cleanup is triggered because no data was delivered.
            if (message.includes('Cannot query field')) {
                const disabled = this.degradeCapabilitiesFromError(message);
                if (disabled.length > 0) {
                    this.adapter.log.warn(
                        `GraphQL schema rejected a field; disabled capabilities ${disabled.join(', ')}. Next poll will rebuild the query.`,
                    );
                    return;
                }
            }
            await this.onConnectionChange(false);
            this.reportError(error);
        } finally {
            this.pollRunning = false;
            if (this.pollPending && !this.stopRequested) {
                this.pollPending = false;
                void this.pollOnce(this.currentDefinitions);
            }
        }
    }

    /**
     * Log a polling error in plain words. The same error is logged only once;
     * repetitions go to the debug log until the connection recovers.
     *
     * @param error - Error thrown by the GraphQL client
     */
    private reportError(error: unknown): void {
        const text = describePollingError(error);
        if (text === this.lastError) {
            this.adapter.log.debug(`Polling still failing: ${text}`);
            return;
        }
        this.lastError = text;
        this.adapter.log.error(text);
    }

    /**
     * Parse a "Cannot query field" error and turn off the matching capability flag.
     * Mutates the shared capabilities object so the next poll rebuilds the query.
     *
     * @param message - Full error message from Apollo/GraphQL
     * @returns Names of capabilities that were disabled
     */
    private degradeCapabilitiesFromError(message: string): string[] {
        const disabled: string[] = [];
        const fieldToCapability: Record<string, CapabilityKey> = {
            temperature: 'temperatureMetrics',
            isUpdateAvailable: 'dockerUpdateFlag',
            containerUpdateStatuses: 'dockerContainerUpdateStatuses',
            pause: 'dockerPause',
            unpause: 'dockerUnpause',
            updateContainer: 'dockerUpdate',
        };
        for (const [field, capability] of Object.entries(fieldToCapability)) {
            const regex = new RegExp(`Cannot query field "${field}"`);
            if (regex.test(message) && this.capabilities[capability]) {
                this.capabilities[capability] = false;
                disabled.push(capability);
                if (!this.reportedMissingFields.has(field)) {
                    this.reportedMissingFields.add(field);
                }
            }
        }
        return disabled;
    }

    /**
     * Schedule the next polling cycle
     *
     * @param pollIntervalMs - Polling interval in milliseconds
     * @param definitions - Array of domain definitions to poll
     */
    private scheduleNextPoll(pollIntervalMs: number, definitions: readonly DomainDefinition[]): void {
        if (this.stopRequested) {
            return;
        }

        this.pollTimer = this.adapter.setTimeout(() => {
            void this.pollOnce(definitions).finally(() => {
                this.scheduleNextPoll(pollIntervalMs, definitions);
            });
        }, pollIntervalMs);
    }

    /**
     * Build a GraphQL query from domain definitions
     *
     * @param definitions - Array of domain definitions to build query from
     */
    private buildQuery(definitions: readonly DomainDefinition[]): string | null {
        const builder = new GraphQLSelectionBuilder(this.capabilities);
        for (const definition of definitions) {
            builder.addSelections(definition.selection);
        }
        return builder.build();
    }

    /**
     * Log GraphQL response for debugging
     *
     * @param data - GraphQL response data to log
     */
    private logGraphQLResponse(data: Record<string, unknown>): void {
        try {
            const serialized = JSON.stringify(data);
            const maxLength = 3000;
            const output = serialized.length > maxLength ? `${serialized.slice(0, maxLength)}…` : serialized;
            this.adapter.log.debug(`GraphQL response: ${output}`);
        } catch (error) {
            this.adapter.log.debug(
                `GraphQL response received but could not be stringified: ${this.describeError(error)}`,
            );
        }
    }

    /**
     * Convert error to string description
     *
     * @param error - Error to describe
     */
    private describeError(error: unknown): string {
        if (error instanceof Error) {
            return error.message;
        }
        return String(error);
    }
}

/**
 * Turn a GraphQL/network error into a short, user-facing log message.
 *
 * @param error - Error thrown by Apollo Client or fetch
 * @returns Message for the ioBroker log
 */
export function describePollingError(error: unknown): string {
    const err = error as { message?: string; name?: string; statusCode?: number; cause?: { code?: string } };
    const message = String(err?.message ?? error);
    const status = typeof err?.statusCode === 'number' ? err.statusCode : undefined;
    const code =
        err?.cause?.code ?? /\b(ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT|ECONNRESET)\b/.exec(message)?.[1];

    if (status === 401 || status === 403 || /\b(401|403)\b|forbidden|unauthori[sz]ed/i.test(message)) {
        return 'Unraid rejected the API key (check the key and its permissions in Unraid: Settings > Management Access > API Keys).';
    }
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError' || /aborted|timeout/i.test(message)) {
        return 'Unraid did not answer in time (request timed out). Will retry with the next poll.';
    }
    if (code) {
        return `Unraid server not reachable (${code}). Check the address in the adapter settings.`;
    }
    return `Polling failed: ${message}`;
}
