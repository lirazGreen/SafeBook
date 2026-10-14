import { parsePdf } from '../src/pdf/parse.ts';
const r = await parsePdf(process.argv[2]);
process.stdout.write(r.rawText);
