const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE,
  waitForConnections: true,
  connectionLimit: 5,
  ssl: process.env.DB_PORT === '4000' ? { rejectUnauthorized: true } : undefined,
});

let ready;

async function initDatabase() {
  if (!ready) {
    ready = (async () => {
      const connection = await pool.getConnection();
      try {
        await connection.query(`
          CREATE TABLE IF NOT EXISTS users (
            id INT AUTO_INCREMENT PRIMARY KEY,
            username VARCHAR(32) NOT NULL UNIQUE,
            display_name VARCHAR(64) NOT NULL,
            email VARCHAR(255) UNIQUE,
            password_hash VARCHAR(255),
            status VARCHAR(32) NOT NULL DEFAULT 'online',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          )
        `);
        try { await connection.query('ALTER TABLE users ADD COLUMN email VARCHAR(255)'); } catch (error) { if (error.code !== 'ER_DUP_FIELDNAME') throw error; }
        try { await connection.query('CREATE UNIQUE INDEX users_email_unique ON users (email)'); } catch (error) { if (!String(error.message).toLowerCase().includes('already exists') && error.code !== 'ER_DUP_KEYNAME') throw error; }
        try { await connection.query('ALTER TABLE users ADD COLUMN password_hash VARCHAR(255)'); } catch (error) { if (error.code !== 'ER_DUP_FIELDNAME') throw error; }
        await connection.query(`
          CREATE TABLE IF NOT EXISTS workspaces (
            id INT AUTO_INCREMENT PRIMARY KEY,
            name VARCHAR(80) NOT NULL,
            owner_id INT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (owner_id) REFERENCES users(id)
          )
        `);
        await connection.query(`
          CREATE TABLE IF NOT EXISTS channels (
            id INT AUTO_INCREMENT PRIMARY KEY,
            workspace_id INT NOT NULL,
            name VARCHAR(80) NOT NULL,
            description VARCHAR(160) NOT NULL DEFAULT '',
            type ENUM('text', 'voice') NOT NULL DEFAULT 'text',
            position INT NOT NULL DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (workspace_id) REFERENCES workspaces(id),
            UNIQUE KEY workspace_channel (workspace_id, name)
          )
        `);
        await connection.query(`
          CREATE TABLE IF NOT EXISTS messages (
            id BIGINT AUTO_INCREMENT PRIMARY KEY,
            channel_id INT NOT NULL,
            author_id INT NOT NULL,
            content TEXT NOT NULL,
            parent_id BIGINT NULL,
            edited_at DATETIME NULL,
            deleted_at DATETIME NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (channel_id) REFERENCES channels(id),
            FOREIGN KEY (author_id) REFERENCES users(id),
            INDEX channel_messages (channel_id, created_at)
          )
        `);
        try { await connection.query('ALTER TABLE messages ADD COLUMN parent_id BIGINT NULL'); } catch (error) { if (error.code !== 'ER_DUP_FIELDNAME') throw error; }
        try { await connection.query('ALTER TABLE messages ADD COLUMN edited_at DATETIME NULL'); } catch (error) { if (error.code !== 'ER_DUP_FIELDNAME') throw error; }
        try { await connection.query('ALTER TABLE messages ADD COLUMN deleted_at DATETIME NULL'); } catch (error) { if (error.code !== 'ER_DUP_FIELDNAME') throw error; }
        await connection.query(`
          CREATE TABLE IF NOT EXISTS message_reactions (
            message_id BIGINT NOT NULL,
            user_id INT NOT NULL,
            emoji VARCHAR(32) NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (message_id, user_id, emoji),
            FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
          )
        `);
        await connection.query(`
          CREATE TABLE IF NOT EXISTS workspace_invites (
            code CHAR(32) PRIMARY KEY,
            workspace_id INT NOT NULL,
            created_by INT NOT NULL,
            expires_at DATETIME NOT NULL,
            FOREIGN KEY (workspace_id) REFERENCES workspaces(id),
            FOREIGN KEY (created_by) REFERENCES users(id)
          )
        `);
        await connection.query(`
          CREATE TABLE IF NOT EXISTS sessions (
            token CHAR(64) PRIMARY KEY,
            user_id INT NOT NULL,
            expires_at DATETIME NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id),
            INDEX session_expiry (expires_at)
          )
        `);

        const [users] = await connection.query('SELECT id FROM users WHERE username = ?', ['you']);
        let userId = users[0]?.id;
        if (!userId) {
          const [result] = await connection.query('INSERT INTO users (username, display_name) VALUES (?, ?)', ['you', 'you']);
          userId = result.insertId;
        }

        const [workspaces] = await connection.query('SELECT id FROM workspaces LIMIT 1');
        let workspaceId = workspaces[0]?.id;
        if (!workspaceId) {
          const [result] = await connection.query('INSERT INTO workspaces (name, owner_id) VALUES (?, ?)', ['Luma House', userId]);
          workspaceId = result.insertId;
        }

        const channels = [
          ['general', 'A cozy corner for everyday conversations', 'text', 0],
          ['random', 'Thoughts, links, and delightful nonsense', 'text', 1],
          ['feedback', 'Help us make Luma feel even better', 'text', 2],
          ['Chill corner', 'A relaxed voice room', 'voice', 3],
          ['Focus flow', 'Quiet company while you work', 'voice', 4],
        ];
        for (const channel of channels) {
          await connection.query(
            'INSERT IGNORE INTO channels (workspace_id, name, description, type, position) VALUES (?, ?, ?, ?, ?)',
            [workspaceId, ...channel],
          );
        }
      } finally {
        connection.release();
      }
    })().catch((error) => {
      ready = undefined;
      throw error;
    });
  }
  return ready;
}

async function query(sql, values) {
  await initDatabase();
  const [rows] = await pool.query(sql, values);
  return rows;
}

module.exports = { initDatabase, query };
