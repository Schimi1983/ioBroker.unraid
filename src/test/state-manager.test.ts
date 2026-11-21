import { expect } from 'chai';

import { StateManager } from '../managers/state-manager';
import type { AdapterInterface } from '../types/adapter-types';
import { PollingManager, describePollingError } from '../managers/polling-manager';
import { allCapabilitiesEnabled } from '../shared/capabilities';
import { domainDefinitions } from '../shared/unraid-domains';

/** Minimal adapter mock that counts object and state writes */
function createAdapterMock(): { adapter: AdapterInterface; calls: Record<string, number> } {
    const calls: Record<string, number> = { setObject: 0, extendObject: 0, setStateChanged: 0 };
    const adapter = {
        namespace: 'unraid.0',
        getAdapterObjectsAsync: () => Promise.resolve({}),
        setObjectAsync: () => {
            calls.setObject++;
            return Promise.resolve();
        },
        extendObjectAsync: () => {
            calls.extendObject++;
            return Promise.resolve();
        },
        setStateChangedAsync: () => {
            calls.setStateChanged++;
            return Promise.resolve();
        },
    } as unknown as AdapterInterface;
    return { adapter, calls };
}

describe('StateManager', () => {
    it('writes objects only once when the definition does not change', async () => {
        const { adapter, calls } = createAdapterMock();
        const manager = new StateManager(adapter);
        for (let i = 0; i < 3; i++) {
            await manager.writeState('array.capacity.freeGb', { type: 'number', role: 'value', unit: 'GB' }, i);
        }
        expect(calls.setObject).to.equal(1);
        // parent channels "array" and "array.capacity"
        expect(calls.extendObject).to.equal(2);
        expect(calls.setStateChanged).to.equal(3);
    });

    it('rewrites the object when role or unit changes', async () => {
        const { adapter, calls } = createAdapterMock();
        const manager = new StateManager(adapter);
        await manager.writeState('server.name', { type: 'string', role: 'text' }, 'a');
        await manager.writeState('server.name', { type: 'string', role: 'info.name' }, 'a');
        expect(calls.setObject).to.equal(2);
    });

    it('writes objects again after forgetObjects()', async () => {
        const { adapter, calls } = createAdapterMock();
        const manager = new StateManager(adapter);
        await manager.writeState('vms.test.state', { type: 'string', role: 'text' }, 'RUNNING');
        manager.forgetObjects('vms.test');
        await manager.writeState('vms.test.state', { type: 'string', role: 'text' }, 'RUNNING');
        expect(calls.setObject).to.equal(2);
    });
});

describe('describePollingError', () => {
    it('explains rejected API keys', () => {
        expect(describePollingError({ message: 'Response not successful', statusCode: 403 })).to.match(/API key/);
    });
    it('explains unreachable servers', () => {
        expect(describePollingError(new Error('fetch failed: connect ECONNREFUSED 192.168.1.14:80'))).to.match(
            /not reachable \(ECONNREFUSED\)/,
        );
    });
    it('explains timeouts', () => {
        const error = new Error('The operation was aborted due to timeout');
        error.name = 'TimeoutError';
        expect(describePollingError(error)).to.match(/timed out/);
    });
});

describe('GraphQL response logging', () => {
    it('summarizes roots and size for the debug log', () => {
        const summary = PollingManager.summarizeResponse(
            { array: { a: 1, b: 2 }, shares: [1, 2, 3], online: true },
            11674,
        );
        expect(summary).to.equal('11.4 KB | array{2} shares[3] online');
    });

    it('reports bytes for small responses and marks an empty one', () => {
        expect(PollingManager.summarizeResponse({}, 2)).to.equal('2 B | (empty)');
    });

    it('logs the summary on debug and the complete response on silly', () => {
        const lines: Array<[string, string]> = [];
        const adapter = {
            log: {
                debug: (m: string) => lines.push(['debug', m]),
                silly: (m: string) => lines.push(['silly', m]),
                info: () => {},
                warn: () => {},
                error: () => {},
            },
        };
        const manager = new PollingManager(adapter as any, {} as any, {} as any, async () => {});
        const data = { array: { state: 'STARTED' }, shares: [1, 2] };
        (manager as any).logGraphQLResponse(data);

        const debugLine = lines.find(([level]) => level === 'debug')?.[1] ?? '';
        const sillyLine = lines.find(([level]) => level === 'silly')?.[1] ?? '';
        expect(debugLine).to.contain('array{1} shares[2]');
        expect(debugLine).to.not.contain('STARTED');
        // silly carries the full payload and is never truncated
        expect(sillyLine).to.contain(JSON.stringify(data));
    });
});

describe('polling during shutdown', () => {
    it('does not report a connection error once stop() was requested', async () => {
        const levels: Array<[string, string]> = [];
        const adapter = {
            log: {
                debug: (m: string) => levels.push(['debug', m]),
                silly: () => {},
                info: () => {},
                warn: () => {},
                error: (m: string) => levels.push(['error', m]),
            },
            setTimeout: () => undefined,
            clearTimeout: () => {},
        };
        const client = { query: () => Promise.reject(new Error('An error occurred! See go.apollo.dev/c/err')) };
        let connectionChanges = 0;
        const manager = new PollingManager(
            adapter as any,
            client as any,
            allCapabilitiesEnabled(),
            async () => {},
            () => {
                connectionChanges++;
                return Promise.resolve();
            },
        );
        manager.stop();
        await (manager as any).pollOnce(domainDefinitions.slice(0, 1));

        expect(levels.filter(([l]) => l === 'error')).to.deep.equal([]);
        expect(connectionChanges, 'connection state must not flip during shutdown').to.equal(0);
    });
});
