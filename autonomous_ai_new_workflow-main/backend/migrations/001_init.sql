-- Current-schema baseline for new installations.
-- MySQL is authoritative and Qdrant remains a derived semantic index.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version VARCHAR(191) NOT NULL PRIMARY KEY,
  applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS users (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(100) NOT NULL,
  entra_oid VARCHAR(64) NULL,
  role ENUM('admin', 'user') NOT NULL DEFAULT 'user',
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by INT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  updated_by INT NULL,
  UNIQUE KEY uq_users_username (username),
  UNIQUE KEY uq_users_entra_oid (entra_oid),
  INDEX idx_users_active_role (is_active, role),
  INDEX idx_users_created_by (created_by),
  INDEX idx_users_updated_by (updated_by),
  CONSTRAINT fk_users_created_by FOREIGN KEY (created_by) REFERENCES users(id),
  CONSTRAINT fk_users_updated_by FOREIGN KEY (updated_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS user_sessions (
  token_hash CHAR(64) NOT NULL PRIMARY KEY,
  user_id INT NOT NULL,
  expires_at DATETIME NOT NULL,
  last_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user_sessions_user_active (user_id, revoked_at, expires_at),
  INDEX idx_user_sessions_expiry (expires_at),
  CONSTRAINT fk_user_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS db_connections (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  connection_name VARCHAR(255) NOT NULL,
  semantic_key VARCHAR(191) NOT NULL,
  db_type VARCHAR(50) NOT NULL,
  host VARCHAR(191) NOT NULL,
  db_user VARCHAR(255) NULL,
  db_password TEXT NULL,
  credentials_json TEXT NULL,
  default_schema VARCHAR(255) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by INT NULL,
  updated_by INT NULL,
  UNIQUE KEY uq_db_connections_semantic_key (semantic_key),
  INDEX idx_db_type (db_type),
  INDEX idx_host (host),
  INDEX idx_db_connections_created_by (created_by),
  INDEX idx_db_connections_updated_by (updated_by),
  CONSTRAINT fk_db_connections_created_by FOREIGN KEY (created_by) REFERENCES users(id),
  CONSTRAINT fk_db_connections_updated_by FOREIGN KEY (updated_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS kpi_metrics (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  connection_id INT NOT NULL,
  metric_name VARCHAR(255) NOT NULL,
  department VARCHAR(100) NOT NULL,
  metric_type VARCHAR(100) NOT NULL,
  formula TEXT NOT NULL,
  table_name VARCHAR(255) NULL COMMENT 'Deprecated single-table compatibility field',
  format VARCHAR(20) NOT NULL DEFAULT 'number',
  dimensions LONGTEXT NULL,
  involved_tables LONGTEXT NOT NULL,
  join_spec LONGTEXT NULL COMMENT 'JSON: KpiJoinSpec[]',
  filter_logic LONGTEXT NULL COMMENT 'JSON: FilterNode AST',
  select_columns LONGTEXT NULL COMMENT 'JSON: explicit output columns',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by INT NULL,
  updated_by INT NULL,
  INDEX idx_kpi_connection_lookup (connection_id, metric_name),
  INDEX idx_kpi_metrics_created_by (created_by),
  INDEX idx_kpi_metrics_updated_by (updated_by),
  CONSTRAINT fk_kpi_metrics_connection FOREIGN KEY (connection_id) REFERENCES db_connections(id) ON DELETE CASCADE,
  CONSTRAINT fk_kpi_metrics_created_by FOREIGN KEY (created_by) REFERENCES users(id),
  CONSTRAINT fk_kpi_metrics_updated_by FOREIGN KEY (updated_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS conversations (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  connection_id INT NOT NULL,
  user_id INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_activity_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_conversations_connection (connection_id),
  INDEX idx_conversations_last_activity (last_activity_at),
  INDEX idx_conversations_user_activity (user_id, last_activity_at),
  CONSTRAINT fk_conversations_connection FOREIGN KEY (connection_id) REFERENCES db_connections(id) ON DELETE CASCADE,
  CONSTRAINT fk_conversations_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS conversation_messages (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  conversation_id VARCHAR(36) NOT NULL,
  role VARCHAR(20) NOT NULL,
  content LONGTEXT NOT NULL,
  query_result LONGTEXT NULL COMMENT 'JSON response with data rows removed',
  table_hint VARCHAR(255) NULL,
  column_hints LONGTEXT NULL COMMENT 'JSON: string[]',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_conversation_messages_lookup (conversation_id, id),
  CONSTRAINT fk_conversation_messages_conversation FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS user_conversations (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  connection_id INT NULL,
  user_id INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_activity_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user_conversations_last_activity (last_activity_at),
  INDEX idx_user_conversations_connection (connection_id),
  INDEX idx_user_conversations_owner_activity (user_id, last_activity_at),
  CONSTRAINT fk_user_conversations_connection FOREIGN KEY (connection_id) REFERENCES db_connections(id) ON DELETE CASCADE,
  CONSTRAINT fk_user_conversations_owner FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS user_conversation_messages (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  conversation_id VARCHAR(36) NOT NULL,
  role VARCHAR(20) NOT NULL,
  content LONGTEXT NOT NULL,
  query_result LONGTEXT NULL COMMENT 'JSON response with data rows removed',
  table_hint VARCHAR(255) NULL,
  column_hints LONGTEXT NULL COMMENT 'JSON: string[]',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user_conversation_messages_lookup (conversation_id, id),
  CONSTRAINT fk_user_conversation_messages_conversation FOREIGN KEY (conversation_id) REFERENCES user_conversations(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS execution_logs (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
  executionId VARCHAR(36) NOT NULL,
  connectionId INT NULL,
  surface VARCHAR(32) NOT NULL DEFAULT 'analytics-ai',
  connector VARCHAR(100) NULL,
  status ENUM('success', 'failure') NOT NULL,
  latencyMs INT NULL,
  authType VARCHAR(20) NULL,
  message TEXT NULL,
  traceId VARCHAR(100) NULL,
  INDEX idx_execution_id (executionId),
  INDEX idx_connection_id (connectionId),
  INDEX idx_timestamp (timestamp)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS connector_metrics (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  connectionId INT NOT NULL,
  connector VARCHAR(100) NOT NULL,
  executions BIGINT NOT NULL DEFAULT 0,
  failures BIGINT NOT NULL DEFAULT 0,
  totalLatencyMs BIGINT NOT NULL DEFAULT 0,
  avgLatencyMs DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  UNIQUE KEY uq_conn_connector (connectionId, connector)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS latency_samples (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  connectionId INT NOT NULL,
  connector VARCHAR(100) NOT NULL,
  latencyMs INT NOT NULL,
  capturedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_conn_time (connectionId, capturedAt)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS semantic_models (
  connection_id INT NOT NULL PRIMARY KEY,
  model_json LONGTEXT NULL,
  status ENUM('none', 'generating', 'ready', 'error') NOT NULL DEFAULT 'none',
  generation_job_id CHAR(36) NULL,
  generation_started_at DATETIME NULL,
  generation_error TEXT NULL,
  last_generated_at DATETIME NULL,
  revision BIGINT UNSIGNED NOT NULL DEFAULT 0,
  vector_status ENUM('not_indexed', 'pending', 'ready', 'error') NOT NULL DEFAULT 'not_indexed',
  vector_error TEXT NULL,
  vector_updated_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by INT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  updated_by INT NULL,
  INDEX idx_semantic_models_status (status, updated_at),
  INDEX idx_semantic_models_vector_status (vector_status, vector_updated_at),
  INDEX idx_semantic_models_created_by (created_by),
  INDEX idx_semantic_models_updated_by (updated_by),
  CONSTRAINT fk_semantic_models_connection FOREIGN KEY (connection_id) REFERENCES db_connections(id) ON DELETE CASCADE,
  CONSTRAINT fk_semantic_models_created_by FOREIGN KEY (created_by) REFERENCES users(id),
  CONSTRAINT fk_semantic_models_updated_by FOREIGN KEY (updated_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS semantic_vector_outbox (
  connection_id INT NOT NULL PRIMARY KEY,
  operation ENUM('upsert', 'delete') NOT NULL,
  target_revision BIGINT UNSIGNED NOT NULL DEFAULT 0,
  attempt_count INT UNSIGNED NOT NULL DEFAULT 0,
  next_attempt_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  locked_by CHAR(36) NULL,
  locked_until DATETIME NULL,
  last_error TEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_semantic_vector_outbox_claim (next_attempt_at, locked_until),
  INDEX idx_semantic_vector_outbox_operation (operation, next_attempt_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
