import { expect, type Locator, type Page } from '@playwright/test';
import { openAdmin } from './AdminShell';

export type HostTab = 'details' | 'sign-in' | 'environment' | 'features' | 'activity';

export const HOST_TABS: HostTab[] = ['details', 'sign-in', 'environment', 'features', 'activity'];

export const KPIS = ['kpi-hosts', 'kpi-features', 'kpi-mfa', 'kpi-sync'] as const;

export function hostPath(uuid: string, tab: Exclude<HostTab, 'activity'> = 'details'): string {
  return tab === 'details' ? `/hosts/${uuid}` : `/hosts/${uuid}/${tab}`;
}

export class HostNav {
  constructor(private readonly page: Page) {}

  tab(name: HostTab): Locator {
    return this.page.locator(`#tab-${name}`);
  }

  all(): Locator {
    return this.page.locator('[data-testid="host-nav"] a');
  }
}

export class DashboardPage {
  readonly welcome: Locator;
  readonly kpis: Locator;
  readonly hostCards: Locator;
  readonly addHost: Locator;
  readonly viewHosts: Locator;
  readonly viewActivity: Locator;
  readonly activity: ActivityList;

  constructor(private readonly page: Page) {
    this.welcome = page.locator('#dashboard-welcome');
    this.kpis = page.locator('#kpis');
    this.hostCards = page.locator('#host-cards [data-testid="host-card"]');
    this.addHost = page.locator('#dashboard-add-host');
    this.viewHosts = page.locator('#dashboard-view-hosts');
    this.viewActivity = page.locator('#dashboard-view-activity');
    this.activity = new ActivityList(page);
  }

  async open(): Promise<void> {
    await openAdmin(this.page, '/');
    await expect(this.kpis).toBeVisible();
  }

  kpi(id: (typeof KPIS)[number]): Locator {
    return this.page.locator(`#${id}`);
  }

  hostCard(uuid: string): Locator {
    return this.page.locator(`#host-cards [data-testid="host-card"][data-host-uuid="${uuid}" i]`);
  }

  signInState(uuid: string): Locator {
    return this.hostCard(uuid).locator('.qc-badge').filter({ hasText: /^(Sign-in ready|No return address)$/ });
  }
}

export class ActivityList {
  readonly list: Locator;
  readonly entries: Locator;
  readonly empty: Locator;

  constructor(page: Page) {
    this.list = page.locator('#activity-list');
    this.entries = page.locator('#activity-list [data-testid="activity-entry"]');
    this.empty = page.locator('#activity-empty');
  }

  text(entry: Locator): Locator {
    return entry.locator('.qc-activity-text');
  }

  meta(entry: Locator): Locator {
    return entry.locator('.qc-activity-meta');
  }

  get latest(): Locator {
    return this.entries.first();
  }
}

export class ActivityPage {
  readonly subtitle: Locator;
  readonly card: Locator;
  readonly showAll: Locator;
  readonly error: Locator;
  readonly list: ActivityList;

  constructor(private readonly page: Page) {
    this.subtitle = page.locator('#activity-subtitle');
    this.card = page.locator('#activity-card');
    this.showAll = page.locator('#activity-all');
    this.error = page.locator('#activity-error');
    this.list = new ActivityList(page);
  }

  async open(hostUuid?: string): Promise<void> {
    await openAdmin(this.page, hostUuid ? `/activity?host=${hostUuid}` : '/activity');
    await expect(this.list.list.or(this.list.empty).or(this.error).first()).toBeVisible();
  }
}
