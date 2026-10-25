import { describe, expect, it } from 'vitest';
import configText from '../wrangler.jsonc?raw';
import packageText from '../package.json?raw';
import recoveryScript from '../scripts/rehearse-d1-recovery.sh?raw';

const config = JSON.parse(configText) as {
  env?: Record<
    string,
    {
      name?: string;
      d1_databases?: Array<{ database_name: string; database_id: string }>;
    }
  >;
};
const packageConfig = JSON.parse(packageText) as {
  scripts: Record<string, string>;
};

describe('retired Staging environment', () => {
  it('keeps only Production as a remote Wrangler environment', () => {
    expect(Object.keys(config.env ?? {})).toEqual(['production']);
  });

  it('keeps Production connected to the Production Worker and database', () => {
    expect(config.env?.production).toMatchObject({
      name: 'keiko-dojo',
      d1_databases: [
        {
          database_name: 'keiko-dojo',
          database_id: '750315f8-ef51-4d6e-86ea-41b076ec9de8',
        },
      ],
    });
  });

  it('does not expose Staging deployment, migration, or recovery paths', () => {
    expect(Object.keys(packageConfig.scripts)).not.toContain('deploy:staging');
    expect(Object.keys(packageConfig.scripts)).not.toContain('migrate:staging');
    expect(recoveryScript).not.toContain('keiko-dojo-staging');
    expect(recoveryScript).not.toMatch(/<staging\|production>/);
  });
});
