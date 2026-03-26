import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const contractPath = path.resolve(__dirname, '../../contracts/src/contract.rs');
const bindingsPath = path.resolve(__dirname, './index.ts');

if (!fs.existsSync(contractPath) || !fs.existsSync(bindingsPath)) {
    console.error(`Could not find required files.\nContract: ${contractPath}\nBindings: ${bindingsPath}`);
    process.exit(1);
}

const contractCode = fs.readFileSync(contractPath, 'utf8');
const bindingsCode = fs.readFileSync(bindingsPath, 'utf8');

// Parse contract exports inside `impl VirtualTokenContract`
const contractFns = [];
const contractSegments = contractCode.split('impl VirtualTokenContract');
if (contractSegments.length > 1) {
    // Use everything after `impl VirtualTokenContract` up to the closing brace? Just parse the rest of the file
    const implBlock = contractSegments[1];
    const lines = implBlock.split('\n');
    for (const line of lines) {
        // looking for things like: `pub fn create_round(`
        const match = line.match(/^\s*pub\s+fn\s+([a-zA-Z0-9_]+)\s*\(/);
        const isPubCrate = line.match(/^\s*pub\(crate\)\s+fn/);
        if (match && !isPubCrate) {
            contractFns.push(match[1]);
        }
    }
}

// Parse bindings for exported methods listed in `fromJSON` block
const bindingsFns = [];
const bindingsSegments = bindingsCode.split('public readonly fromJSON = {');
if (bindingsSegments.length > 1) {
    const fromJsonBlock = bindingsSegments[1].split('}')[0];
    const lines = fromJsonBlock.split('\n');
    for (const line of lines) {
        const match = line.match(/(?:^\s*|\s+)([a-zA-Z0-9_]+)\s*:\s*this\.txFromJSON/);
        if (match) {
            bindingsFns.push(match[1]);
        }
    }
}

if (contractFns.length === 0) {
    console.error("Failed to parse contract functions from:", contractPath);
    process.exit(1);
}

if (bindingsFns.length === 0) {
    console.error("Failed to parse binding functions from:", bindingsPath);
    process.exit(1);
}

const missingInBindings = contractFns.filter(fn => !bindingsFns.includes(fn));
const missingInContract = bindingsFns.filter(fn => !contractFns.includes(fn));

if (missingInBindings.length > 0 || missingInContract.length > 0) {
    console.error("❌ ABI parity check failed: Drift detected");

    if (missingInBindings.length > 0) {
        console.error("- The following methods are present in the contract but missing from the bindings map:");
        missingInBindings.forEach(fn => console.error(`  - ${fn}`));
    }

    if (missingInContract.length > 0) {
        console.error("- The following methods are in the bindings map but missing from the contract:");
        missingInContract.forEach(fn => console.error(`  - ${fn}`));
    }
    process.exit(1);
} else {
    console.log("✅ ABI parity check passed: All contract methods are synced with TS bindings.");
    process.exit(0);
}
