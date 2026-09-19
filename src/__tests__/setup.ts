// Use an in-memory SQLite database for all tests — no disk I/O, no cleanup needed.
process.env.DATABASE_PATH = ":memory:";

// Suppress logger output during tests — only real errors pass through
process.env.LOG_LEVEL = "error";

// Fixed test wallet — system program address, valid Solana pubkey
process.env.NEXT_PUBLIC_PAYMENT_RECEIVER_WALLET_ADDRESS = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
