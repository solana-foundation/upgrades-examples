import solanaConfig from '@solana-config/oxc/oxlint';
import { defineConfig } from 'oxlint';

export default defineConfig({
    extends: [solanaConfig],
    // web3js-v3/src/client is the upstream SDK, vendored as-is; see scripts/vendor-ts-client.sh.
    ignorePatterns: ['dist', 'node_modules', 'web3js-v3/src/client'],
    options: { typeAware: true },
});
