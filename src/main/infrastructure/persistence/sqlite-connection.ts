import type BetterSqlite3 from "better-sqlite3";

export type SqliteConnection = Pick<BetterSqlite3.Database, "prepare" | "exec" | "pragma">;

export type SqliteTransaction = (operation: () => void) => () => void;
