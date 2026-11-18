import { expect } from 'chai';

import { StateManager } from '../managers/state-manager';
import type { AdapterInterface } from '../types/adapter-types';
import { describePollingError } from '../managers/polling-manager';

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
