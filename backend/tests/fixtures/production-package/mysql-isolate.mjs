/**
 * Issue #108 —— 测试隔离库 helper
 *
 * 目的：npm test 会并发跑多个测试文件；若多个"真实 MySQL"文件共用同一个开发/CI 库，
 * 会对 nonce / snapshot / import / dramas 等表互相污染（已实测：并发全量下偶发失败）。
 * 本 helper 为单个测试进程创建一个唯一库并把 process.env.MYSQL_DATABASE 指向它，
 * 结束调用 cleanup() 直接 DROP，进程间完全隔离（与 source-version-db.test.mjs 同模式）。
 *
 * 前提：仅支持 MYSQL_HOST/MYSQL_USER/MYSQL_PASSWORD 形态（CI 与本机均如此）。
 * 仅提供 DATABASE_URL 时无法派生 admin 连接，返回 changed=false（回退共享库并自行注意清理）。
 */
import mysql from 'mysql2/promise'
import crypto from 'node:crypto'

export function mysqlEnvConfigured() {
  return Boolean(process.env.MYSQL_HOST || process.env.DATABASE_URL)
}

export async function isolateDatabase(prefix) {
  const adminOptions = process.env.DATABASE_URL
    ? null
    : {
        host: process.env.MYSQL_HOST || '127.0.0.1',
        port: Number(process.env.MYSQL_PORT || 3306),
        user: process.env.MYSQL_TEST_ADMIN_USER || process.env.MYSQL_USER || 'root',
        password: process.env.MYSQL_TEST_ADMIN_PASSWORD ?? process.env.MYSQL_PASSWORD ?? 'huobao',
        connectTimeout: 5000,
      }
  if (!adminOptions) return { changed: false, cleanup: async () => undefined }
  const admin = await mysql.createConnection(adminOptions)
  const dbName = `${prefix}_${crypto.randomBytes(8).toString('hex')}`
  await admin.query(`CREATE DATABASE \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`)
  process.env.MYSQL_DATABASE = dbName
  return {
    changed: true,
    name: dbName,
    cleanup: async () => {
      try { await admin.query(`DROP DATABASE IF EXISTS \`${dbName}\``) } catch { /* already dropped */ }
      await admin.end().catch(() => undefined)
    },
  }
}

/**
 * 建唯一库 → 设置 MYSQL_DATABASE → 加载生产 db pool（将指向该库）→ initMySqlSchema 建表。
 * 必须在动态 import ../src/index.ts 之前调用。返回 { changed, cleanup }。
 */
export async function prepareIsolatedMySql(prefix) {
  const isolated = await isolateDatabase(prefix)
  if (!isolated.changed) return { changed: false, cleanup: isolated.cleanup }
  const dbModule = await import(new URL('../../../src/db/index.ts', import.meta.url))
  const { initMySqlSchema } = await import(new URL('../../../src/db/mysql-schema.ts', import.meta.url))
  await initMySqlSchema(dbModule.pool)
  return { changed: true, name: isolated.name, cleanup: isolated.cleanup }
}
