import { expect } from 'chai';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildSchema, parse, validate } from 'graphql';

import { CAPABILITY_PROBE_MUTATION, CAPABILITY_PROBE_QUERY } from '../apollo-client';
import { CAPABILITY_FIELDS, allCapabilitiesEnabled, capabilitiesFromValidationErrors } from '../shared/capabilities';
import { PollingManager } from '../managers/polling-manager';
import { domainDefinitions } from '../shared/unraid-domains';

const schemaSdl = readFileSync(join(__dirname, '..', '..', 'docs', 'schema.graphql'), 'utf8');

/**
 * Validate a probe document like the Unraid server does and return the error messages.
 *
 * @param sdl - Schema definition
 * @param document - Probe document
 */
function validateProbe(sdl: string, document: string): string[] {
    return validate(buildSchema(sdl), parse(document)).map(e => e.message);
}

describe('capability probe (validation only)', () => {
    it('is rejected by validation on a current schema and reports no missing fields', () => {
        const messages = [
            ...validateProbe(schemaSdl, CAPABILITY_PROBE_QUERY),
            ...validateProbe(schemaSdl, CAPABILITY_PROBE_MUTATION),
        ];
        expect(messages.some(m => m.includes('is never used'))).to.equal(true);
        expect(messages.some(m => m.includes('Cannot query field'))).to.equal(false);
        expect(capabilitiesFromValidationErrors(messages)).to.deep.equal({
            temperatureMetrics: true,
            dockerUpdateFlag: true,
            dockerContainerUpdateStatuses: true,
            dockerPause: true,
            dockerUnpause: true,
            dockerUpdate: true,
            dockerRestart: true,
            dockerUpdateAll: true,
        });
    });

    it('detects missing fields of older Unraid versions', () => {
        // Simulate an older API by renaming the fields that newer Unraid versions added
        const oldSdl = schemaSdl
            .replace('temperature: TemperatureMetrics', 'temperatureRemoved: TemperatureMetrics')
            .replace('isUpdateAvailable: Boolean', 'isUpdateAvailableRemoved: Boolean')
            .replace('pause(id: PrefixedID!): DockerContainer!', 'pauseRemoved(id: PrefixedID!): DockerContainer!');
        const messages = [
            ...validateProbe(oldSdl, CAPABILITY_PROBE_QUERY),
            ...validateProbe(oldSdl, CAPABILITY_PROBE_MUTATION),
        ];
        const caps = capabilitiesFromValidationErrors(messages);
        expect(caps.temperatureMetrics).to.equal(false);
        expect(caps.dockerUpdateFlag).to.equal(false);
        expect(caps.dockerPause).to.equal(false);
        expect(caps.dockerUnpause).to.equal(true);
        expect(caps.dockerRestart).to.equal(true);
    });
});

describe('capability degradation at runtime', () => {
    it('registers every capability flag in CAPABILITY_FIELDS', () => {
        // The startup probe and the runtime fallback in PollingManager both derive
        // capabilities from this map. A capability that is missing here can never be
        // turned off, which makes the whole polling query fail permanently on servers
        // that do not know the field.
        const mapped = new Set<string>(Object.values(CAPABILITY_FIELDS));
        const unmapped = Object.keys(allCapabilitiesEnabled()).filter(key => !mapped.has(key));
        expect(unmapped).to.deep.equal([]);
    });

    it('turns off the matching capability when the server rejects a field', async () => {
        const capabilities = allCapabilitiesEnabled();
        const warnings: string[] = [];
        const adapter = {
            log: { debug: () => {}, info: () => {}, warn: (m: string) => warnings.push(m), error: () => {} },
            setTimeout: () => undefined,
            clearTimeout: () => {},
        };
        const client = {
            query: () => Promise.reject(new Error('Cannot query field "temperature" on type "Metrics".')),
        };
        const definition = domainDefinitions.find(d => d.id === 'metrics.temperature.board');
        expect(definition, 'temperature domain definition').to.not.equal(undefined);

        const manager = new PollingManager(
            adapter as any,
            client as any,
            capabilities,
            async () => {},
            async () => {},
        );
        await (manager as any).pollOnce([definition]);

        expect(capabilities.temperatureMetrics).to.equal(false);
        // Other flags must stay untouched
        expect(capabilities.dockerPause).to.equal(true);
        expect(warnings.join(' ')).to.contain('temperatureMetrics');
    });
});
