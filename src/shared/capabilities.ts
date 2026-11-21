/**
 * Capability flags for Unraid API features that may not exist on older servers.
 * Detected once at adapter startup via a validation-only probe (see UnraidApolloClient.probeCapabilities); referenced by query
 * builder and control manager to gate feature-specific fields and mutations.
 */
export interface Capabilities {
    /** Metrics.temperature endpoint with sensor array */
    temperatureMetrics: boolean;
    /** DockerContainer.isUpdateAvailable field (nullable, may often be null) */
    dockerUpdateFlag: boolean;
    /** Docker.containerUpdateStatuses list (authoritative per-container update status) */
    dockerContainerUpdateStatuses: boolean;
    /** DockerMutations.pause */
    dockerPause: boolean;
    /** DockerMutations.unpause */
    dockerUnpause: boolean;
    /** DockerMutations.updateContainer */
    dockerUpdate: boolean;
}

export type CapabilityKey = keyof Capabilities;

export const ALL_CAPABILITIES_DISABLED: Capabilities = {
    temperatureMetrics: false,
    dockerUpdateFlag: false,
    dockerContainerUpdateStatuses: false,
    dockerPause: false,
    dockerUnpause: false,
    dockerUpdate: false,
};

/**
 * Create a capabilities object with all flags initially enabled.
 * Used as a default when introspection has not run yet.
 */
export function allCapabilitiesEnabled(): Capabilities {
    return {
        temperatureMetrics: true,
        dockerUpdateFlag: true,
        dockerContainerUpdateStatuses: true,
        dockerPause: true,
        dockerUnpause: true,
        dockerUpdate: true,
    };
}

/** Fields whose absence disables a capability, as reported by "Cannot query field" validation errors */
export const CAPABILITY_FIELDS: Readonly<Record<string, CapabilityKey>> = {
    temperature: 'temperatureMetrics',
    isUpdateAvailable: 'dockerUpdateFlag',
    containerUpdateStatuses: 'dockerContainerUpdateStatuses',
    pause: 'dockerPause',
    unpause: 'dockerUnpause',
    updateContainer: 'dockerUpdate',
};

/**
 * Derive capability flags from GraphQL validation error messages.
 * Every capability is enabled unless its field is reported as unknown.
 *
 * @param messages - Error messages returned by the server
 * @returns Capability flags
 */
export function capabilitiesFromValidationErrors(messages: readonly string[]): Capabilities {
    const capabilities = allCapabilitiesEnabled();
    for (const message of messages) {
        const match = /Cannot query field "([^"]+)"/.exec(message);
        const capability = match ? CAPABILITY_FIELDS[match[1]] : undefined;
        if (capability) {
            capabilities[capability] = false;
        }
    }
    return capabilities;
}
