import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';

export type EnvironmentName = 'local' | 'dev' | 'prod';

export interface TestEnvironment {
  name: EnvironmentName;
  adminUrl: string;
  adminApiUrl: string | null;
  identityUrl: string;
  hostName: string;
  ignoreHttpsErrors: boolean;
  admin: Credentials | null;
  driver: Credentials | null;
  appUrl: string | null;
  appApiUrl: string | null;
  appTimeZone: string | null;
  appAdmin: Credentials | null;
  appAdminAuthenticatorKey: string | null;
  localSql: LocalSql | null;
  driversApiUrl: string | null;
  localStackUrl: string | null;
  mobileClientId: string | null;
  hostClient: OidcClient | null;
  driverUiClient: OidcClient | null;
  adminApiClient: ServiceClient | null;
  driversServiceClient: ServiceClient | null;
  identitySql: LocalSql | null;
  masterSql: LocalSql | null;
  driversSql: LocalSql | null;
  identityLogDir: string | null;
  landingUrl: string | null;
  identityHostCacheSeconds: number;
  allowWrites: boolean;
  allowCreateHosts: boolean;
  allowRestart: boolean;
}

export interface Credentials {
  email: string;
  password: string;
}

export interface LocalSql {
  server: string;
  database: string;
}

export interface OidcClient {
  clientId: string;
  redirectUri: string;
}

export interface ServiceClient {
  clientId: string;
  secret: string;
}

const ENVIRONMENTS: EnvironmentName[] = ['local', 'dev', 'prod'];

function loadFile(file: string): void {
  if (fs.existsSync(file)) {
    dotenv.config({ path: file, override: false });
  }
}

function flag(name: string): boolean {
  return (process.env[name] ?? '').trim().toLowerCase() === 'true';
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is not set. Check env/${process.env.TEST_ENV}.env.`);
  }
  return value.replace(/\/+$/, '');
}

function optional(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value.replace(/\/+$/, '') : null;
}

function credentials(emailVar: string, passwordVar: string): Credentials | null {
  const email = process.env[emailVar]?.trim();
  const password = process.env[passwordVar];
  return email && password ? { email, password } : null;
}

function serviceClient(clientIdVar: string, secretVar: string): ServiceClient | null {
  const clientId = process.env[clientIdVar]?.trim();
  const secret = process.env[secretVar]?.trim();
  return clientId && secret ? { clientId, secret } : null;
}

function oidcClient(clientIdVar: string, redirectUriVar: string): OidcClient | null {
  const clientId = process.env[clientIdVar]?.trim();
  const redirectUri = process.env[redirectUriVar]?.trim();
  return clientId && redirectUri ? { clientId, redirectUri } : null;
}

export function loadEnvironment(): TestEnvironment {
  const name = (process.env.TEST_ENV ?? 'local').trim().toLowerCase() as EnvironmentName;
  if (!ENVIRONMENTS.includes(name)) {
    throw new Error(`TEST_ENV must be one of ${ENVIRONMENTS.join(', ')}; got '${name}'.`);
  }
  process.env.TEST_ENV = name;

  const envDir = path.resolve(__dirname, '..', 'env');
  loadFile(path.join(envDir, `${name}.secrets.env`));
  loadFile(path.join(envDir, `${name}.app.secrets.env`));
  loadFile(path.join(envDir, `${name}.env`));

  const isProd = name === 'prod';
  const sqlServer = optional('LOCAL_SQL_SERVER');
  const sqlDatabase = optional('LOCAL_SQL_DATABASE');
  const identitySqlDatabase = optional('IDENTITY_SQL_DATABASE');
  const masterSqlDatabase = optional('MASTER_SQL_DATABASE');
  const driversSqlDatabase = optional('DRIVERS_SQL_DATABASE');

  return {
    name,
    adminUrl: required('ADMIN_URL'),
    adminApiUrl: optional('ADMIN_API_URL'),
    identityUrl: required('IDENTITY_URL'),
    hostName: required('HOST_NAME'),
    ignoreHttpsErrors: flag('IGNORE_HTTPS_ERRORS'),
    admin: credentials('ADMIN_EMAIL', 'ADMIN_PASSWORD'),
    driver: credentials('DRIVER_EMAIL', 'DRIVER_PASSWORD'),
    appUrl: optional('APP_URL'),
    appApiUrl: optional('APP_API_URL'),
    appTimeZone: process.env.APP_TIME_ZONE?.trim() || null,
    appAdmin: credentials('APP_ADMIN_EMAIL', 'APP_ADMIN_PASSWORD'),
    appAdminAuthenticatorKey: process.env.APP_ADMIN_AUTHENTICATOR_KEY?.trim() || null,
    localSql: name === 'local' && sqlServer && sqlDatabase ? { server: sqlServer, database: sqlDatabase } : null,
    driversApiUrl: optional('DRIVERS_API_URL'),
    localStackUrl: name === 'local' ? optional('LOCALSTACK_URL') : null,
    mobileClientId: process.env.MOBILE_CLIENT_ID?.trim() || null,
    hostClient: oidcClient('HOST_CLIENT_ID', 'HOST_REDIRECT_URI'),
    driverUiClient: oidcClient('DRIVER_UI_CLIENT_ID', 'DRIVER_UI_REDIRECT_URI'),
    adminApiClient: serviceClient('ADMIN_API_CLIENT_ID', 'ADMIN_API_CLIENT_SECRET'),
    driversServiceClient: serviceClient('DRIVERS_SERVICE_CLIENT_ID', 'DRIVERS_SERVICE_CLIENT_SECRET'),
    identityLogDir: name === 'local' && optional('IDENTITY_LOG_DIR') ? path.resolve(__dirname, '..', optional('IDENTITY_LOG_DIR')!) : null,
    identitySql: name === 'local' && sqlServer && identitySqlDatabase ? { server: sqlServer, database: identitySqlDatabase } : null,
    masterSql: name === 'local' && sqlServer && masterSqlDatabase ? { server: sqlServer, database: masterSqlDatabase } : null,
    driversSql: name === 'local' && sqlServer && driversSqlDatabase ? { server: sqlServer, database: driversSqlDatabase } : null,
    landingUrl: process.env.LANDING_URL?.trim() || null,
    identityHostCacheSeconds: Number(process.env.IDENTITY_HOST_CACHE_SECONDS?.trim() || '330'),
    allowWrites: !isProd && flag('ALLOW_WRITES'),
    allowCreateHosts: !isProd && flag('ALLOW_CREATE_HOSTS'),
    allowRestart: !isProd && flag('ALLOW_RESTART'),
  };
}

export const env = loadEnvironment();

export const ADMIN_STATE = path.join('.auth', env.name, 'admin.json');

export const APP_STATE = path.join('.auth', env.name, 'app-admin.json');
