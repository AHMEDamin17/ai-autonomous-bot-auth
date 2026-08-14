import { DatabaseConnection } from '../../types/types';
import { decryptSecret } from '../../utils/secretCrypto';

export interface AuthContext {
  tokenPresent: boolean;
  authType: 'credentials' | 'none';
}

export function buildAuthContext(connection: DatabaseConnection): AuthContext {
  const user = (connection.db_user || "").trim();
  const password = (decryptSecret(connection.db_password) || "").trim();
  const credentialsJson = (connection.credentials_json || "").trim();
  const hasCredentials = Boolean((user && password) || credentialsJson);
  return {
    tokenPresent: hasCredentials,
    authType: hasCredentials ? 'credentials' : 'none',
  };
}
