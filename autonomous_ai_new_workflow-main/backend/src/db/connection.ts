import * as mysql from "mysql2/promise";

let lazyPool: mysql.Pool | null = null;

const pool = new Proxy({} as mysql.Pool, {
  get(target, prop, receiver) {
    if (!lazyPool) {
      lazyPool = mysql.createPool({
        host: process.env.DB_HOST ?? "localhost",
        port: Number(process.env.DB_PORT ?? 3306),
        user: process.env.DB_USER ?? "root",
        password: process.env.DB_PASSWORD ?? "root",
        database: process.env.DB_NAME ?? "autonomous_db",
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0,
        connectTimeout: 10000,
      });
    }
    const value = Reflect.get(lazyPool, prop, receiver);
    if (typeof value === "function") {
      return value.bind(lazyPool);
    }
    return value;
  }
});

export default pool;

