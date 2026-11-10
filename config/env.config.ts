import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';

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
  expoStubLog: string | null;
  identityHostCacheSeconds: number;
  inviteHostPrivateJwk: string | null;
  inviteWrongPrivateJwk: string | null;
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

/** The quarryconnect-e2e folder. Build file paths from here, never from a module's own __dirname. */
export const ROOT_DIR = path.resolve(__dirname, '..');

/** Files the specs upload or read (images, documents). */
export const TEST_DATA_DIR = path.join(ROOT_DIR, 'test-data');

const blankToUndefined = (value: unknown) => (typeof value === 'string' && value.trim() === '' ? undefined : value);
const url = (name: string) => z.preprocess(blankToUndefined, z.string().trim().url(`${name} must be a full URL`));
const optionalUrl = (name: string) => url(name).optional();
const booleanFlag = z.preprocess(blankToUndefined, z.enum(['true', 'false', 'TRUE', 'FALSE', 'True', 'False']).optional());

/**
 * Shape of the raw variables, checked once before any test runs so a typo in env/*.env fails fast with
 * every problem listed. Credentials and SQL names stay free-form; they are optional per environment.
 */
const rawEnvSchema = z.object({
  ADMIN_URL: url('ADMIN_URL'),
  IDENTITY_URL: url('IDENTITY_URL'),
  HOST_NAME: z.string({ required_error: 'HOST_NAME is required' }).trim().min(1, 'HOST_NAME is required'),
  ADMIN_API_URL: optionalUrl('ADMIN_API_URL'),
  APP_URL: optionalUrl('APP_URL'),
  APP_API_URL: optionalUrl('APP_API_URL'),
  DRIVERS_API_URL: optionalUrl('DRIVERS_API_URL'),
  LOCALSTACK_URL: optionalUrl('LOCALSTACK_URL'),
  LANDING_URL: optionalUrl('LANDING_URL'),
  HOST_REDIRECT_URI: optionalUrl('HOST_REDIRECT_URI'),
  DRIVER_UI_REDIRECT_URI: optionalUrl('DRIVER_UI_REDIRECT_URI'),
  IDENTITY_HOST_CACHE_SECONDS: z.preprocess(blankToUndefined, z.coerce.number().int().nonnegative().optional()),
  IGNORE_HTTPS_ERRORS: booleanFlag,
  ALLOW_WRITES: booleanFlag,
  ALLOW_CREATE_HOSTS: booleanFlag,
  ALLOW_RESTART: booleanFlag,
});

function validateRawEnvironment(name: EnvironmentName, envDir: string): void {
  const result = rawEnvSchema.safeParse(process.env);
  if (result.success) return;
  const issues = result.error.issues.map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`).join('\n');
  throw new Error(`Invalid test environment for TEST_ENV="${name}".\n${issues}\nChecked ${path.join(envDir, `${name}.env`)} and its *.secrets.env files.`);
}

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

  const envDir = path.join(ROOT_DIR, 'env');
  loadFile(path.join(envDir, `${name}.secrets.env`));
  loadFile(path.join(envDir, `${name}.app.secrets.env`));
  loadFile(path.join(envDir, `${name}.env`));
  validateRawEnvironment(name, envDir);

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
    identityLogDir: name === 'local' && optional('IDENTITY_LOG_DIR') ? path.resolve(ROOT_DIR, optional('IDENTITY_LOG_DIR')!) : null,
    identitySql: name === 'local' && sqlServer && identitySqlDatabase ? { server: sqlServer, database: identitySqlDatabase } : null,
    masterSql: name === 'local' && sqlServer && masterSqlDatabase ? { server: sqlServer, database: masterSqlDatabase } : null,
    driversSql: name === 'local' && sqlServer && driversSqlDatabase ? { server: sqlServer, database: driversSqlDatabase } : null,
    landingUrl: process.env.LANDING_URL?.trim() || null,
    expoStubLog: name === 'local' ? process.env.EXPO_STUB_LOG?.trim() || null : null,
    identityHostCacheSeconds: Number(process.env.IDENTITY_HOST_CACHE_SECONDS?.trim() || '330'),
    inviteHostPrivateJwk: process.env.INVITE_TEST_HOST_PRIVATE_JWK?.trim() || null,
    inviteWrongPrivateJwk: process.env.INVITE_TEST_WRONG_PRIVATE_JWK?.trim() || null,
    allowWrites: !isProd && flag('ALLOW_WRITES'),
    allowCreateHosts: !isProd && flag('ALLOW_CREATE_HOSTS'),
    allowRestart: !isProd && flag('ALLOW_RESTART'),
  };
}

export const env = loadEnvironment();

export const ADMIN_STATE = path.join('.auth', env.name, 'admin.json');

export const APP_STATE = path.join('.auth', env.name, 'app-admin.json');
