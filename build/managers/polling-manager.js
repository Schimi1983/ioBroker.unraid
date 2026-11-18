"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PollingManager = void 0;
exports.describePollingError = describePollingError;
const selection_builder_1 = require("../graphql/selection-builder");
/**
 * Manages polling cycles and GraphQL queries
 */
class PollingManager {
    adapter;
    apolloClient;
    capabilities;
    onDataReceived;
    onConnectionChange;
    pollTimer;
    stopRequested = false;
    currentDefinitions = [];
    reportedMissingFields = new Set();
    /** True while a poll request is running */
    pollRunning = false;
    /** A poll was requested while another one was running */
    pollPending = false;
    /** Last reported error (used to log repeated failures only once) */
    lastError;
    /**
     * Create a new polling manager
     *
     * @param adapter - Adapter interface for logging and timers
     * @param apolloClient - Apollo client for GraphQL queries
     * @param capabilities - Mutable capability flags; updated on runtime fallback
     * @param onDataReceived - Callback function when data is received
     * @param onConnectionChange - Callback with the result of every poll (true = server answered)
     */
    constructor(adapter, apolloClient, capabilities, onDataReceived, onConnectionChange = async () => { }) {
        this.adapter = adapter;
        this.apolloClient = apolloClient;
        this.capabilities = capabilities;
        this.onDataReceived = onDataReceived;
        this.onConnectionChange = onConnectionChange;
    }
    /**
     * Start polling with the given interval
     *
     * @param pollIntervalMs - Polling interval in milliseconds
     * @param definitions - Array of domain definitions to poll
     */
    start(pollIntervalMs, definitions) {
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
    poll() {
        if (this.currentDefinitions.length === 0) {
            this.adapter.log.debug('Cannot poll - no definitions available');
            return;
        }
        void this.pollOnce(this.currentDefinitions);
    }
    /**
     * Stop polling
     */
    stop() {
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
    async pollOnce(definitions) {
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
            const data = await this.apolloClient.query(query);
            this.logGraphQLResponse(data);
            await this.onConnectionChange(true);
            if (this.lastError) {
                this.adapter.log.info('Connection to the Unraid server restored.');
                this.lastError = undefined;
            }
            try {
                await this.onDataReceived(data);
            }
            catch (processingError) {
                // Server answered; a failure here is local (objects DB) and not a connection problem
                this.adapter.log.error(`Processing Unraid data failed: ${this.describeError(processingError)}`);
            }
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            // Handle "Cannot query field X on type Y" by disabling the related capability
            // and deferring a rebuilt query to the next poll cycle. Existing states are
            // preserved — no cleanup is triggered because no data was delivered.
            if (message.includes('Cannot query field')) {
                const disabled = this.degradeCapabilitiesFromError(message);
                if (disabled.length > 0) {
                    this.adapter.log.warn(`GraphQL schema rejected a field; disabled capabilities ${disabled.join(', ')}. Next poll will rebuild the query.`);
                    return;
                }
            }
            await this.onConnectionChange(false);
            this.reportError(error);
        }
        finally {
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
    reportError(error) {
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
    degradeCapabilitiesFromError(message) {
        const disabled = [];
        const fieldToCapability = {
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
    scheduleNextPoll(pollIntervalMs, definitions) {
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
    buildQuery(definitions) {
        const builder = new selection_builder_1.GraphQLSelectionBuilder(this.capabilities);
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
    logGraphQLResponse(data) {
        try {
            const serialized = JSON.stringify(data);
            const maxLength = 3000;
            const output = serialized.length > maxLength ? `${serialized.slice(0, maxLength)}…` : serialized;
            this.adapter.log.debug(`GraphQL response: ${output}`);
        }
        catch (error) {
            this.adapter.log.debug(`GraphQL response received but could not be stringified: ${this.describeError(error)}`);
        }
    }
    /**
     * Convert error to string description
     *
     * @param error - Error to describe
     */
    describeError(error) {
        if (error instanceof Error) {
            return error.message;
        }
        return String(error);
    }
}
exports.PollingManager = PollingManager;
/**
 * Turn a GraphQL/network error into a short, user-facing log message.
 *
 * @param error - Error thrown by Apollo Client or fetch
 * @returns Message for the ioBroker log
 */
function describePollingError(error) {
    const err = error;
    const message = String(err?.message ?? error);
    const status = typeof err?.statusCode === 'number' ? err.statusCode : undefined;
    const code = err?.cause?.code ?? /\b(ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT|ECONNRESET)\b/.exec(message)?.[1];
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
//# sourceMappingURL=polling-manager.js.map