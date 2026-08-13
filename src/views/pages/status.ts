/**
 * Public service-status dashboard.
 *
 * The visual language follows Upptime: a prominent overall state, one row per
 * component, compact 90-day availability bars and an incident timeline. Every
 * value comes from a live probe or cron-recorded KV history; unmonitored days
 * are rendered as unknown instead of being presented as 100% uptime.
 */

import type { HealthCheckState, HealthReport } from '../../services/health';
import type {
  StatusAggregate,
  StatusComponentKey,
  StatusHistory,
  StatusIncident,
} from '../../services/statusHistory';
import { html, raw } from '../../utils/html';

interface ComponentDefinition {
  key: StatusComponentKey;
  name: string;
  state: HealthCheckState;
  description: string;
  latency?: number;
}

export interface StatusPageInput {
  siteName: string;
  report: HealthReport;
  history: StatusHistory;
}

type DisplayState = 'operational' | 'degraded' | 'outage';
type DayState = 'up' | 'partial' | 'down' | 'unknown';

const COMPONENT_NAMES: Record<StatusComponentKey, string> = {
  edge: 'Website & API',
  database: 'Database',
  storage: 'Media storage',
  schema: 'Database schema',
};

function displayState(report: HealthReport): DisplayState {
  if (report.readiness === 'not_ready') return 'outage';
  if (report.readiness === 'degraded') return 'degraded';
  return 'operational';
}

function overallCopy(state: DisplayState): { title: string; body: string } {
  switch (state) {
    case 'outage':
      return {
        title: 'Major service outage',
        body: 'One or more core systems are unavailable. We are investigating.',
      };
    case 'degraded':
      return {
        title: 'Degraded service',
        body: 'The site is online, but some features may be temporarily unavailable.',
      };
    default:
      return {
        title: 'All systems operational',
        body: 'AES is running normally.',
      };
  }
}

function components(report: HealthReport): ComponentDefinition[] {
  const schemaDescription =
    report.checks.schema === 'ok'
      ? `${report.schema.applied} of ${report.schema.applied + report.schema.pending} migrations applied.`
      : report.checks.schema === 'missing'
        ? `${report.schema.pending} database migration${report.schema.pending === 1 ? '' : 's'} pending.`
        : 'The application schema is incomplete or unavailable.';

  return [
    {
      key: 'edge',
      name: COMPONENT_NAMES.edge,
      state: 'ok',
      description: 'The status page and Worker are responding.',
      latency: report.latencyMs.total,
    },
    {
      key: 'database',
      name: COMPONENT_NAMES.database,
      state: report.checks.database,
      description:
        report.checks.database === 'ok'
          ? 'Queries are responding normally.'
          : 'Posts, accounts and other data may be unavailable.',
      latency: report.latencyMs.database,
    },
    {
      key: 'storage',
      name: COMPONENT_NAMES.storage,
      state: report.checks.storage,
      description:
        report.checks.storage === 'ok'
          ? 'Uploads and media delivery are available.'
          : 'Uploads and media delivery may be unavailable.',
      latency: report.latencyMs.storage,
    },
    {
      key: 'schema',
      name: COMPONENT_NAMES.schema,
      state: report.checks.schema,
      description: schemaDescription,
      latency: report.latencyMs.schema,
    },
  ];
}

function statusLabel(state: HealthCheckState): string {
  if (state === 'ok') return 'Operational';
  if (state === 'missing') return 'Migration required';
  return 'Unavailable';
}

function dateKeys(timestamp: string): string[] {
  const today = new Date(timestamp);
  today.setUTCHours(0, 0, 0, 0);
  const days: string[] = [];
  for (let offset = 89; offset >= 0; offset--) {
    const day = new Date(today);
    day.setUTCDate(today.getUTCDate() - offset);
    days.push(day.toISOString().slice(0, 10));
  }
  return days;
}

function dayState(aggregate: StatusAggregate | undefined): DayState {
  if (!aggregate || aggregate.total <= 0) return 'unknown';
  if (aggregate.ok === aggregate.total) return 'up';
  if (aggregate.ok === 0) return 'down';
  return 'partial';
}

function mergeLiveState(recorded: DayState, live: HealthCheckState): DayState {
  if (live === 'ok') return recorded === 'unknown' ? 'up' : recorded;
  if (recorded === 'unknown' || recorded === 'down') return 'down';
  return 'partial';
}

function historyLabel(history: StatusHistory, key: StatusComponentKey): string {
  let ok = 0;
  let total = 0;
  for (const day of history.days) {
    ok += day.checks[key].ok;
    total += day.checks[key].total;
  }
  if (!total) return 'Live check only';
  const percentage = (ok / total) * 100;
  const digits = percentage >= 99.995 || percentage === 0 ? 2 : 1;
  return `${percentage.toFixed(digits)}% · ${total} check${total === 1 ? '' : 's'}`;
}

function availabilityBars(
  report: HealthReport,
  history: StatusHistory,
  component: ComponentDefinition,
): string {
  const byDate = new Map(history.days.map((day) => [day.date, day.checks[component.key]]));
  const dates = dateKeys(report.timestamp);
  const today = dates.at(-1);

  return html`
    <div class="status-history" aria-label="90-day availability: ${historyLabel(history, component.key)}">
      <div class="status-history__bars" aria-hidden="true">
        ${dates.map((date) => {
          const recorded = dayState(byDate.get(date));
          const state = date === today ? mergeLiveState(recorded, component.state) : recorded;
          const text = state === 'up' ? 'Operational' : state === 'down' ? 'Unavailable' : state === 'partial' ? 'Partial outage' : 'No data';
          return raw(`<span class="status-day status-day--${state}" title="${date}: ${text}"></span>`);
        })}
      </div>
      <div class="status-history__legend muted">
        <span>90 days ago</span>
        <strong>${historyLabel(history, component.key)}</strong>
        <span>Today</span>
      </div>
    </div>
  `;
}

function componentRow(
  report: HealthReport,
  history: StatusHistory,
  component: ComponentDefinition,
): string {
  const kind = component.state === 'ok' ? 'operational' : 'outage';
  return html`
    <article class="status-component status-component--${kind}" data-status-component="${component.key}">
      <div class="status-component__head">
        <div class="status-component__copy">
          <h3>${component.name}</h3>
          <p data-status-description>${component.description}</p>
        </div>
        <div class="status-component__result">
          <span class="status-badge status-badge--${kind}" data-status-badge>${statusLabel(component.state)}</span>
          ${component.latency === undefined
            ? ''
            : raw(html`<span class="status-latency muted" data-status-latency>${component.latency} ms</span>`)}
        </div>
      </div>
      ${raw(availabilityBars(report, history, component))}
    </article>
  `;
}

function affectedLabel(affected: StatusComponentKey[]): string {
  return affected.map((key) => COMPONENT_NAMES[key]).filter(Boolean).join(', ');
}

function incidentCard(incident: StatusIncident): string {
  const resolved = Boolean(incident.resolvedAt);
  return html`
    <article class="status-incident ${resolved ? 'status-incident--resolved' : 'status-incident--active'}">
      <div class="status-incident__marker" aria-hidden="true"></div>
      <div class="status-incident__body">
        <div class="status-incident__head">
          <h3>${resolved ? 'Service disruption resolved' : 'Service disruption under investigation'}</h3>
          <span class="status-badge status-badge--${resolved ? 'operational' : 'outage'}">${resolved ? 'Resolved' : 'Investigating'}</span>
        </div>
        <p>Affected systems: ${affectedLabel(incident.affected)}.</p>
        <p class="status-incident__time muted">
          Started <time datetime="${incident.startedAt}">${incident.startedAt.replace('T', ' ').slice(0, 16)} UTC</time>
          ${incident.resolvedAt
            ? raw(html` · Resolved <time datetime="${incident.resolvedAt}">${incident.resolvedAt.replace('T', ' ').slice(0, 16)} UTC</time>`)
            : ''}
        </p>
      </div>
    </article>
  `;
}

function currentIncident(report: HealthReport, history: StatusHistory): StatusIncident | null {
  if (report.readiness === 'ready') return null;
  const open = history.incidents.find((incident) => !incident.resolvedAt);
  if (open) return open;
  const affected = components(report)
    .filter((component) => component.state !== 'ok')
    .map((component) => component.key);
  return {
    id: 'live-incident',
    startedAt: report.timestamp,
    affected,
  };
}

export function renderStatusPage(input: StatusPageInput): string {
  const state = displayState(input.report);
  const overall = overallCopy(state);
  const active = currentIncident(input.report, input.history);
  const resolved = input.history.incidents.filter((incident) => Boolean(incident.resolvedAt)).slice(0, 8);

  return html`
    <div class="status-page" data-status-page data-overall="${state}">
      <header class="status-hero">
        <div>
          <p class="status-eyebrow">Live service status</p>
          <h1>${input.siteName} status</h1>
          <p>Current health and 90-day availability for the services behind ${input.siteName}.</p>
        </div>
        <button class="btn btn--ghost btn--small status-refresh" type="button" data-status-refresh>
          Refresh status
        </button>
      </header>

      <section class="status-overall status-overall--${state}" data-status-overall role="status" aria-live="polite">
        <span class="status-overall__icon" aria-hidden="true"></span>
        <div>
          <h2 data-status-overall-title>${overall.title}</h2>
          <p data-status-overall-body>${overall.body}</p>
        </div>
      </section>

      <div class="status-meta muted">
        <span>Environment: <strong>${input.report.environment}</strong></span>
        <span aria-hidden="true">·</span>
        <span>Last checked <time data-status-checked datetime="${input.report.timestamp}">${input.report.timestamp.replace('T', ' ').slice(0, 19)} UTC</time></span>
        <span aria-hidden="true">·</span>
        <a href="/health">Health JSON</a>
      </div>

      <section class="status-section" aria-labelledby="systems-title">
        <div class="status-section__head">
          <div>
            <p class="status-eyebrow">Uptime</p>
            <h2 id="systems-title">Systems</h2>
          </div>
          <span class="muted">Updated automatically every minute</span>
        </div>
        <div class="status-components">
          ${components(input.report).map((component) => raw(componentRow(input.report, input.history, component)))}
        </div>
      </section>

      ${active
        ? raw(html`
          <section class="status-section" aria-labelledby="active-incidents-title">
            <div class="status-section__head">
              <div>
                <p class="status-eyebrow">Current event</p>
                <h2 id="active-incidents-title">Active incident</h2>
              </div>
            </div>
            ${raw(incidentCard(active))}
          </section>`)
        : ''}

      <section class="status-section" aria-labelledby="history-title">
        <div class="status-section__head">
          <div>
            <p class="status-eyebrow">Timeline</p>
            <h2 id="history-title">Incident history</h2>
          </div>
        </div>
        ${resolved.length
          ? raw(html`<div class="status-incidents">${resolved.map((incident) => raw(incidentCard(incident)))}</div>`)
          : raw(html`
            <div class="status-empty">
              <span class="status-empty__check" aria-hidden="true">✓</span>
              <div>
                <h3>No resolved incidents recorded</h3>
                <p class="muted">Incident history will appear here as monitoring data is collected.</p>
              </div>
            </div>`)}
      </section>

      <footer class="status-footer muted">
        <span>Monitoring every 15 minutes</span>
        <span aria-hidden="true">·</span>
        <a href="/">Back to ${input.siteName}</a>
        <span aria-hidden="true">·</span>
        <a href="/health">API</a>
      </footer>
    </div>
  `;
}
