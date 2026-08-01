// The binary's entry point. Everything it does lives in ./axon, which stays
// importable — the executable and the library used to be the same file, and it
// decided whether to run by pattern-matching its own path in argv.
import { main } from "./axon";

void main();
