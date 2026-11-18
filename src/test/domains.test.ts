import { expect } from 'chai';

import stateTranslations from '../translations/state-names.json';
import {
    DOCKER_CONTROL_STATES,
    DOCKER_UPDATE_ALL_STATE,
    domainDefinitions,
    isoToTimestamp,
    leadingNumberOrNull,
} from '../shared/unraid-domains';

const translations = stateTranslations as Record<string, Record<string, string>>;
const languages = ['en', 'de', 'ru', 'pt', 'nl', 'fr', 'it', 'es', 'pl', 'uk', 'zh-cn'];

describe('domain definitions', () => {
    it('have a translation in all languages for every new state', () => {
        const ids = [
            'info.os.bootTime',
            ...domainDefinitions
                .filter(d => d.id === 'array.parityCheck' || d.id === 'notifications.overview')
                .flatMap(d => d.states.map(s => s.id)),
            'commands.restart',
            DOCKER_UPDATE_ALL_STATE.id,
        ];
        for (const id of ids) {
            expect(translations[id], id).to.be.an('object');
            for (const lang of languages) {
                expect(translations[id][lang], `${id}/${lang}`).to.be.a('string').and.not.equal('');
            }
        }
    });

    it('use writable button roles for the new controls', () => {
        const restart = DOCKER_CONTROL_STATES.find(s => s.id === 'commands.restart');
        expect(restart?.common.role).to.equal('button.press');
        expect(DOCKER_UPDATE_ALL_STATE.common.role).to.equal('button.press');
        expect(DOCKER_UPDATE_ALL_STATE.common.write).to.equal(true);
    });
});

describe('value transforms', () => {
    it('converts ISO dates to timestamps', () => {
        expect(isoToTimestamp('2026-11-18T10:00:00.000Z')).to.equal(Date.UTC(2026, 10, 18, 10));
        expect(isoToTimestamp(null)).to.equal(null);
        expect(isoToTimestamp('not a date')).to.equal(null);
    });

    it('reads the number of a speed text', () => {
        expect(leadingNumberOrNull('152.3 MB/s')).to.equal(152.3);
        expect(leadingNumberOrNull('0')).to.equal(0);
        expect(leadingNumberOrNull('n/a')).to.equal(null);
        expect(leadingNumberOrNull(12)).to.equal(12);
    });
});
