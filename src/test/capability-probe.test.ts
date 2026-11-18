import { expect } from 'chai';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildSchema, parse, validate } from 'graphql';

import { CAPABILITY_PROBE_MUTATION, CAPABILITY_PROBE_QUERY } from '../apollo-client';
import { capabilitiesFromValidationErrors } from '../shared/capabilities';

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
    });
});
