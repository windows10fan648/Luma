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
            supabase_id VARCHAR(80) UNIQUE,
            password_hash VARCHAR(255),
            status VARCHAR(32) NOT NULL DEFAULT 'online',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          )
        `);
        try { await connection.query('ALTER TABLE attachments MODIFY data LONGBLOB NULL'); } catch (error) { if (error.code !== 'ER_BAD_FIELD_ERROR' && error.code !== 'ER_NO_SUCH_TABLE') throw error; }
        try { await connection.query('ALTER TABLE attachments ADD COLUMN storage_path VARCHAR(500) NULL'); } catch (error) { if (error.code !== 'ER_DUP_FIELDNAME' && error.code !== 'ER_NO_SUCH_TABLE') throw error; }
        try { await connection.query('ALTER TABLE users ADD COLUMN email VARCHAR(255)'); } catch (error) { if (error.code !== 'ER_DUP_FIELDNAME') throw error; }
        try { await connection.query('CREATE UNIQUE INDEX users_email_unique ON users (email)'); } catch (error) { if (!String(error.message).toLowerCase().includes('already exists') && error.code !== 'ER_DUP_KEYNAME') throw error; }
        try { await connection.query('ALTER TABLE users ADD COLUMN password_hash VARCHAR(255)'); } catch (error) { if (error.code !== 'ER_DUP_FIELDNAME') throw error; }
        try { await connection.query('ALTER TABLE users ADD COLUMN supabase_id VARCHAR(80)'); } catch (error) { if (error.code !== 'ER_DUP_FIELDNAME') throw error; }
        try { await connection.query('CREATE UNIQUE INDEX users_supabase_unique ON users (supabase_id)'); } catch (error) { if (!String(error.message).toLowerCase().includes('already exists') && error.code !== 'ER_DUP_KEYNAME') throw error; }
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
        try { await connection.query('ALTER TABLE messages ADD COLUMN attachment_id BIGINT NULL'); } catch (error) { if (error.code !== 'ER_DUP_FIELDNAME') throw error; }
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
        await connection.query(`
          CREATE TABLE IF NOT EXISTS workspace_members (
            workspace_id INT NOT NULL,
            user_id INT NOT NULL,
            role ENUM('owner', 'admin', 'moderator', 'member') NOT NULL DEFAULT 'member',
            banned_until DATETIME NULL,
            joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (workspace_id, user_id),
            FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
          )
        `);
        await connection.query(`
          CREATE TABLE IF NOT EXISTS attachments (
            id BIGINT AUTO_INCREMENT PRIMARY KEY,
            uploader_id INT NOT NULL,
            file_name VARCHAR(255) NOT NULL,
            mime_type VARCHAR(120) NOT NULL,
            file_size INT NOT NULL,
            data LONGBLOB NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (uploader_id) REFERENCES users(id)
          )
        `);
        await connection.query(`
          CREATE TABLE IF NOT EXISTS notifications (
            id BIGINT AUTO_INCREMENT PRIMARY KEY,
            user_id INT NOT NULL,
            type VARCHAR(40) NOT NULL,
            title VARCHAR(160) NOT NULL,
            body VARCHAR(500) NOT NULL,
            link VARCHAR(255),
            read_at DATETIME NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id),
            INDEX user_notifications (user_id, created_at)
          )
        `);
        await connection.query(`
          CREATE TABLE IF NOT EXISTS friend_requests (
            id BIGINT AUTO_INCREMENT PRIMARY KEY,
            requester_id INT NOT NULL,
            addressee_id INT NOT NULL,
            status ENUM('pending', 'accepted', 'declined', 'canceled') NOT NULL DEFAULT 'pending',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            FOREIGN KEY (requester_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (addressee_id) REFERENCES users(id) ON DELETE CASCADE,
            INDEX request_pair (requester_id, addressee_id, status)
          )
        `);
        await connection.query(`
          CREATE TABLE IF NOT EXISTS friendships (
            user_id INT NOT NULL,
            friend_id INT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (user_id, friend_id),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (friend_id) REFERENCES users(id) ON DELETE CASCADE
          )
        `);
        await connection.query(`
          CREATE TABLE IF NOT EXISTS conversations (
            id BIGINT AUTO_INCREMENT PRIMARY KEY,
            kind ENUM('dm', 'group') NOT NULL DEFAULT 'dm',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          )
        `);
        await connection.query(`
          CREATE TABLE IF NOT EXISTS conversation_members (
            conversation_id BIGINT NOT NULL,
            user_id INT NOT NULL,
            joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (conversation_id, user_id),
            FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
          )
        `);
        await connection.query(`
          CREATE TABLE IF NOT EXISTS direct_messages (
            id BIGINT AUTO_INCREMENT PRIMARY KEY,
            conversation_id BIGINT NOT NULL,
            author_id INT NOT NULL,
            content TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
            FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE CASCADE,
            INDEX dm_history (conversation_id, created_at)
          )
        `);
        await connection.query(`
          CREATE TABLE IF NOT EXISTS voice_signals (
            id BIGINT AUTO_INCREMENT PRIMARY KEY,
            channel_id INT NOT NULL,
            sender_id INT NOT NULL,
            recipient_id INT NULL,
            payload JSON NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
            FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE,
            INDEX voice_poll (channel_id, id)
          )
        `);
        await connection.query(`
          CREATE TABLE IF NOT EXISTS subscriptions (
            user_id INT PRIMARY KEY,
            stripe_customer_id VARCHAR(120) UNIQUE,
            stripe_subscription_id VARCHAR(120) UNIQUE,
            plan VARCHAR(32) NOT NULL DEFAULT 'free',
            status VARCHAR(32) NOT NULL DEFAULT 'inactive',
            current_period_end DATETIME NULL,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
          )
        `);
        await connection.query(`
          CREATE TABLE IF NOT EXISTS promo_codes (
            code VARCHAR(64) PRIMARY KEY,
            plan VARCHAR(32) NOT NULL DEFAULT 'premium',
            duration_days INT NOT NULL,
            max_redemptions INT NOT NULL DEFAULT 1,
            redemption_count INT NOT NULL DEFAULT 0,
            expires_at DATETIME NULL,
            created_by INT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
          )
        `);
        await connection.query(`
          CREATE TABLE IF NOT EXISTS promo_redemptions (
            code VARCHAR(64) NOT NULL,
            user_id INT NOT NULL,
            plan VARCHAR(32) NOT NULL,
            expires_at DATETIME NOT NULL,
            redeemed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (code, user_id),
            FOREIGN KEY (code) REFERENCES promo_codes(code) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
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
        await connection.query('INSERT IGNORE INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)', [workspaceId, userId, 'owner']);
        await connection.query('INSERT IGNORE INTO workspace_members (workspace_id, user_id, role) SELECT ?, id, \'member\' FROM users WHERE password_hash IS NOT NULL', [workspaceId]);

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
