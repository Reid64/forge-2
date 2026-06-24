// Minimal type stub for better-sqlite3 — real package installed in a later prompt
// Allows TypeScript to compile the learning engine without the npm package present.
declare module 'better-sqlite3' {
  interface DatabaseConstructor {
    new(filename: string, options?: Database.Options): Database.Database;
    (filename: string, options?: Database.Options): Database.Database;
  }

  namespace Database {
    interface Database {
      prepare(sql: string): Statement;
      exec(source: string): void;
      close(): void;
      pragma(source: string, simplify?: boolean): unknown;
    }
    interface Statement {
      run(...bindParameters: unknown[]): RunResult;
      get(...bindParameters: unknown[]): unknown;
      all(...bindParameters: unknown[]): unknown[];
    }
    interface RunResult {
      changes: number;
      lastInsertRowid: number | bigint;
    }
    interface Options {
      readonly?: boolean;
      fileMustExist?: boolean;
      timeout?: number;
    }
  }

  const Database: DatabaseConstructor;
  export = Database;
}
