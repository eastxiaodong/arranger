import initSqlJs, { Database as SqlJsDatabase, BindParams } from 'sql.js';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Thin wrapper around sql.js Database to provide a better-sqlite3-like API
 */
export class SqlJsDb {
  private db!: SqlJsDatabase;
  private dbPath: string;

  private constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  static async create(dbPath: string): Promise<SqlJsDb> {
    const wrapper = new SqlJsDb(dbPath);
    await wrapper.initialize();
    return wrapper;
  }

  private async initialize() {
    const SQL = await initSqlJs({
      locateFile: (file: string) => {
        return path.join(__dirname, '../../node_modules/sql.js/dist', file);
      }
    });

    if (fs.existsSync(this.dbPath)) {
      const buffer = fs.readFileSync(this.dbPath);
      this.db = new SQL.Database(buffer);
    } else {
      this.db = new SQL.Database();
    }
  }

  exec(sql: string) {
    this.db.run(sql);
    this.save();
  }

  pragma(pragma: string) {
    // sql.js doesn't support all pragmas, ignore them
    return null;
  }

  prepare(sql: string) {
    const db = this.db;
    const save = () => this.save();
    let lastInsertRowid = 0;

    return {
      run: (...params: any[]) => {
        db.run(sql, params);
        save();
        return { changes: db.getRowsModified(), lastInsertRowid };
      },
      get: (...params: any[]) => {
        const result = db.exec(sql, params);
        if (result.length === 0 || result[0].values.length === 0) {
          return undefined;
        }
        return this.rowToObject(result[0].columns, result[0].values[0]);
      },
      all: (...params: any[]) => {
        const result = db.exec(sql, params);
        if (result.length === 0) {
          return [];
        }
        return result[0].values.map(row => 
          this.rowToObject(result[0].columns, row)
        );
      }
    };
  }

  private rowToObject(columns: string[], values: any[]): any {
    const obj: any = {};
    columns.forEach((col, i) => {
      obj[col] = values[i];
    });
    return obj;
  }

  private save() {
    const data = this.db.export();
    const buffer = Buffer.from(data);
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.dbPath, buffer);
  }

  close() {
    this.db.close();
  }
}

