import type { AdapterInterface } from '../types/adapter-types';
import type { DomainDefinition, StateMapping } from '../shared/unraid-domains';
import { resolveValue } from '../utils/data-transformers';
import stateTranslations from '../translations/state-names.json';

/**
 * Manages ioBroker state objects and their values
 */
export class StateManager {
    private readonly createdChannels = new Set<string>();
    private readonly createdStates = new Set<string>();
    /**
     * Last written object definition per id (serialized `common` subset).
     *
     * Note: Objects used to be rewritten with setObjectAsync on every poll cycle
     * (one write per state plus one per parent channel). Comparing against this cache
     * keeps the objects DB untouched unless name, role, type or unit actually change.
     */
    private readonly objectSignatures = new Map<string, string>();

    /**
     * Create a new state manager
     *
     * @param adapter - Adapter interface for state operations
     */
    constructor(private readonly adapter: AdapterInterface) {}

    /**
     * Populate the in-memory existing-state index from the ioBroker objects DB.
     * Called once at adapter start so that `writeState` does not wipe valid
     * values with `null` when re-registering previously known states.
     */
    async hydrateFromExistingObjects(): Promise<void> {
        const objects = await this.adapter.getAdapterObjectsAsync();
        const prefix = `${this.adapter.namespace}.`;
        for (const fullId of Object.keys(objects)) {
            const obj = objects[fullId];
            const relativeId = fullId.startsWith(prefix) ? fullId.slice(prefix.length) : fullId;
            if (!relativeId) {
                continue;
            }
            if (obj.type === 'state') {
                this.createdStates.add(relativeId);
                const common = obj.common as Partial<ioBroker.StateCommon>;
                this.objectSignatures.set(
                    relativeId,
                    StateManager.stateSignature(common.name, common.role, common.type, common.unit),
                );
            } else if (obj.type === 'channel') {
                this.createdChannels.add(relativeId);
                this.objectSignatures.set(relativeId, StateManager.channelSignature(obj.common?.name));
            }
        }
    }

    /**
     * Initialize static states from domain definitions
     *
     * @param definitions - Array of domain definitions to initialize states from
     */
    async initializeStaticStates(definitions: readonly DomainDefinition[]): Promise<void> {
        for (const definition of definitions) {
            for (const mapping of definition.states) {
                await this.writeState(mapping.id, mapping.common, null);
            }
        }
    }

    /**
     * Apply domain definition to query result data
     *
     * @param definition - Domain definition to apply
     * @param data - Query result data to process
     */
    async applyDefinition(definition: DomainDefinition, data: Record<string, unknown>): Promise<void> {
        // First check if this domain's data exists in the result
        const rootPath = definition.selection[0]?.root;
        if (!rootPath || !(rootPath in data)) {
            // Skip if this domain wasn't queried
            return;
        }

        for (const mapping of definition.states) {
            const rawValue = resolveValue(data, mapping.path);
            const transformed = mapping.transform ? mapping.transform(rawValue) : rawValue;
            await this.writeState(mapping.id, mapping.common, transformed);
        }
    }

    /**
     * Create or update a state with proper object hierarchy
     *
     * @param id - State ID
     * @param common - Common state properties
     * @param value - State value to set
     */
    async writeState(id: string, common: StateMapping['common'], value: unknown): Promise<void> {
        await this.ensureChannelHierarchy(id);

        // Get translation object or use id as fallback
        let translations = (stateTranslations as Record<string, any>)[id];

        // For dynamic resources, try to get translation for the field name (last part of ID)
        let fieldName: string | undefined;
        if (!translations) {
            const parts = id.split('.');
            const isDynamicResource =
                id.startsWith('docker.containers.') ||
                id.startsWith('vms.') ||
                id.startsWith('shares.') ||
                id.startsWith('array.disks.') ||
                id.startsWith('array.parities.') ||
                id.startsWith('array.caches.') ||
                id.startsWith('metrics.cpu.cores.') ||
                id.startsWith('metrics.temperature.board.');

            if (isDynamicResource && parts.length > 0) {
                fieldName = parts[parts.length - 1];
                translations = (stateTranslations as Record<string, any>)[fieldName];
            }
        }

        // If no translation found, use fieldName or id as fallback
        const name: ioBroker.StringOrTranslated = translations || fieldName || id;

        const stateAlreadyExisted = this.createdStates.has(id);

        const signature = StateManager.stateSignature(name, common.role, common.type, common.unit);
        if (this.objectSignatures.get(id) !== signature) {
            await this.adapter.setObjectAsync(id, {
                type: 'state',
                common: {
                    name,
                    role: common.role,
                    type: common.type,
                    unit: common.unit,
                    read: true,
                    write: false,
                },
                native: {},
            });
            this.objectSignatures.set(id, signature);
        }
        this.createdStates.add(id);

        // Only write state value if:
        //   - the state is brand new (needs an initial value so ioBroker shows it), or
        //   - the caller provided an explicit non-null value.
        // This prevents valid values from being wiped to null when re-registering
        // existing states (e.g. when new fields are added to a dynamic resource).
        if (!stateAlreadyExisted || value !== null) {
            const normalizedValue = value === undefined ? null : (value as ioBroker.StateValue);
            await this.adapter.setStateChangedAsync(id, normalizedValue, true);
        }
    }

    /**
     * Update state value without creating object
     *
     * @param id - State ID
     * @param value - State value to set
     */
    async updateState(id: string, value: unknown): Promise<void> {
        const normalizedValue = value === undefined ? null : (value as ioBroker.StateValue);
        await this.adapter.setStateChangedAsync(id, normalizedValue, true);
    }

    /**
     * Clean up the object tree by removing objects not in allowed set
     *
     * @param allowedIds - Set of allowed object IDs to keep
     */
    async cleanupObjectTree(allowedIds: Set<string>): Promise<void> {
        const objects = await this.adapter.getAdapterObjectsAsync();
        for (const fullId of Object.keys(objects)) {
            const relativeId = fullId.startsWith(`${this.adapter.namespace}.`)
                ? fullId.slice(this.adapter.namespace.length + 1)
                : fullId;

            if (!relativeId) {
                continue;
            }

            if (!this.shouldKeepObject(relativeId, allowedIds)) {
                try {
                    await this.adapter.delObjectAsync(relativeId, { recursive: true });
                } catch (error) {
                    this.adapter.log.warn(`Failed to remove object ${relativeId}: ${this.describeError(error)}`);
                }
            }
        }

        this.createdChannels.clear();
        this.createdStates.clear();
        this.objectSignatures.clear();
    }

    /**
     * Forget cached object definitions below a prefix (e.g. after a resource was deleted),
     * so the objects are written again if the resource comes back.
     *
     * @param prefix - Relative object id prefix without trailing dot
     */
    forgetObjects(prefix: string): void {
        for (const set of [this.createdStates, this.createdChannels]) {
            for (const id of set) {
                if (id === prefix || id.startsWith(`${prefix}.`)) {
                    set.delete(id);
                }
            }
        }
        for (const id of this.objectSignatures.keys()) {
            if (id === prefix || id.startsWith(`${prefix}.`)) {
                this.objectSignatures.delete(id);
            }
        }
    }

    /**
     * Collect all static object IDs from domain definitions
     *
     * @param definitions - Array of domain definitions to collect IDs from
     */
    collectStaticObjectIds(definitions: readonly DomainDefinition[]): Set<string> {
        const ids = new Set<string>();

        const addPrefixes = (identifier: string): void => {
            const parts = identifier.split('.');
            for (let index = 1; index <= parts.length; index += 1) {
                ids.add(parts.slice(0, index).join('.'));
            }
        };

        for (const definition of definitions) {
            addPrefixes(definition.id);
            for (const state of definition.states) {
                addPrefixes(state.id);
            }
        }

        return ids;
    }

    /**
     * Clear internal tracking sets
     */
    clear(): void {
        this.createdChannels.clear();
        this.createdStates.clear();
        this.objectSignatures.clear();
    }

    /**
     * Build the comparison key for a state object.
     *
     * @param name - Object name (string or translations)
     * @param role - ioBroker role
     * @param type - Value type
     * @param unit - Unit (optional)
     * @returns Serialized signature
     */
    static stateSignature(name: unknown, role: unknown, type: unknown, unit: unknown): string {
        return JSON.stringify([name ?? null, role ?? null, type ?? null, unit ?? null]);
    }

    /**
     * Build the comparison key for a channel object.
     *
     * @param name - Channel name (string or translations)
     * @returns Serialized signature
     */
    static channelSignature(name: unknown): string {
        return JSON.stringify([name ?? null]);
    }

    private shouldKeepObject(objectId: string, allowedIds: Set<string>): boolean {
        if (allowedIds.has(objectId)) {
            return true;
        }

        const parts = objectId.split('.');
        for (let index = parts.length - 1; index > 0; index -= 1) {
            const candidate = parts.slice(0, index).join('.');
            if (allowedIds.has(candidate)) {
                return true;
            }
        }

        return false;
    }

    private async ensureChannelHierarchy(id: string): Promise<void> {
        const parts = id.split('.');
        for (let index = 1; index < parts.length; index += 1) {
            const channelId = parts.slice(0, index).join('.');

            // Try to get translation object, otherwise use channelId as fallback
            const translations = (stateTranslations as Record<string, any>)[channelId];
            let name: ioBroker.StringOrTranslated = translations || channelId;

            // For dynamic resources, use only the resource name as label (no translations)
            if (channelId.startsWith('docker.containers.') && index === 3) {
                // Extract the container name (last part of the channelId)
                name = parts[2];
            } else if (channelId.startsWith('shares.') && index === 2) {
                // Extract the share name
                name = parts[1];
            } else if (channelId.startsWith('vms.') && index === 2) {
                // Extract the VM name
                name = parts[1];
            } else if (channelId.startsWith('array.disks.') && index === 3) {
                // For array disks, show "Disk X" or parity/cache name
                name = `Disk ${parts[2]}`;
            } else if (channelId.startsWith('array.parities.') && index === 3) {
                name = `Parity ${parts[2]}`;
            } else if (channelId.startsWith('array.caches.') && index === 3) {
                name = `Cache ${parts[2]}`;
            } else if (channelId.startsWith('metrics.cpu.cores.') && index === 4) {
                name = `Core ${parts[3]}`;
            } else if (channelId.startsWith('metrics.cpu.packages.') && index === 4) {
                name = `Package ${parts[3]}`;
            }

            // Write the channel only if it is new or its name changed
            const signature = StateManager.channelSignature(name);
            if (this.objectSignatures.get(channelId) !== signature) {
                await this.adapter.extendObjectAsync(channelId, {
                    type: 'channel',
                    common: {
                        name,
                    },
                    native: {},
                });
                this.objectSignatures.set(channelId, signature);
            }

            this.createdChannels.add(channelId);
        }
    }

    private describeError(error: unknown): string {
        if (error instanceof Error) {
            return error.message;
        }
        return String(error);
    }
}
