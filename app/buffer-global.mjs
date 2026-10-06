// The Meteora and SPL packages read a global Buffer while their modules load.
// Import this before them: ES modules evaluate imports in source order.
import {Buffer} from 'buffer';
if (!globalThis.Buffer) globalThis.Buffer = Buffer;
