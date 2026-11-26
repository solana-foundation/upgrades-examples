import solanaFmt from '@solana-config/oxc/oxfmt';
import { defineConfig } from 'oxfmt';

// web3js-v3/src/client is the upstream SDK, vendored as-is; see scripts/vendor-ts-client.sh.
export default defineConfig({ ...solanaFmt, ignorePatterns: ['web3js-v3/src/client'] });
