/**
 * Upload assistant — renders the upload checklist (see app/upload-checklist.ts) as live steps.
 * The API-key input and the profile form are host elements mounted into their steps.
 */

import type { ChecklistResult, CheckTarget, CheckStatus } from '../../app/upload-checklist.ts';

const STATUS_ICON: Record<CheckStatus, string> = { ok: '✓', warn: '!', error: '✕' };

export interface UploadAssistantOptions {
    el: HTMLElement;
    /** Mounted into the "API key" step. */
    keyEl?: HTMLElement | null;
    /** Mounted into the "Profile" step. */
    profileEl?: HTMLElement | null;
    onJump?: (target: CheckTarget) => void;
}

export class UploadAssistant {
    el: HTMLElement;
    keyEl: HTMLElement | null;
    profileEl: HTMLElement | null;
    onJump: (target: CheckTarget) => void;
    /** Steps the user opened/closed by hand (survives re-renders). */
    _expanded = new Map<string, boolean>();
    /** Next target per issue key, so repeated clicks walk through all affected labels. */
    _cursor = new Map<string, number>();

    constructor(opts: UploadAssistantOptions) {
        this.el = opts.el;
        this.keyEl = opts.keyEl || null;
        this.profileEl = opts.profileEl || null;
        this.onJump = opts.onJump || (() => {});
    }

    render(result: ChecklistResult) {
        // Keep mounted host elements alive across re-renders
        this.keyEl?.remove();
        this.profileEl?.remove();
        this.el.innerHTML = '';

        result.steps.forEach((step, n) => {
            const item = document.createElement('div');
            item.className = `ua-step ua-${step.status}`;

            const hdr = document.createElement('button');
            hdr.type = 'button';
            hdr.className = 'ua-step-hdr';
            hdr.innerHTML = `<span class="ua-icon" aria-hidden="true"></span><span class="ua-title"></span><span class="ua-summary"></span>`;
            hdr.querySelector('.ua-icon')!.textContent = STATUS_ICON[step.status];
            hdr.querySelector('.ua-title')!.textContent = `${n + 1}. ${step.title}`;
            hdr.querySelector('.ua-summary')!.textContent = step.summary;
            hdr.title = { ok: 'OK', warn: 'Warnings', error: 'Needs fixing' }[step.status];
            item.appendChild(hdr);

            const body = document.createElement('div');
            body.className = 'ua-step-body';
            for (const issue of step.issues) body.appendChild(this._buildIssue(step.id, issue));
            const host = step.id === 'key' ? this.keyEl : step.id === 'profile' ? this.profileEl : null;
            if (host) body.appendChild(host);
            item.appendChild(body);

            // Open by default when something needs attention; the key/profile forms are always reachable
            const auto = step.status !== 'ok';
            const open = this._expanded.get(step.id) ?? auto;
            const hasContent = body.childElementCount > 0;
            body.hidden = !open || !hasContent;
            item.classList.toggle('expanded', !body.hidden);
            hdr.disabled = !hasContent;
            hdr.addEventListener('click', () => {
                body.hidden = !body.hidden;
                item.classList.toggle('expanded', !body.hidden);
                this._expanded.set(step.id, !body.hidden);
            });

            this.el.appendChild(item);
        });
    }

    _buildIssue(stepId: string, issue: { level: string; message: string; targets?: CheckTarget[] }) {
        const row = document.createElement('div');
        row.className = `ua-issue ua-issue-${issue.level}`;
        const text = document.createElement('span');
        text.textContent = issue.message;
        row.appendChild(text);

        const targets = (issue.targets || []).filter((t) => t.kind !== 'key' && t.kind !== 'profile');
        if (targets.length) {
            const key = `${stepId}:${issue.message}`;
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'ua-jump';
            btn.textContent = targets.length > 1 ? 'Next →' : 'Show →';
            btn.title = targets.length > 1 ? `Jump to the next of ${targets.length}` : 'Jump there';
            btn.addEventListener('click', () => {
                const i = (this._cursor.get(key) ?? 0) % targets.length;
                this._cursor.set(key, i + 1);
                this.onJump(targets[i]);
            });
            row.appendChild(btn);
        }
        return row;
    }
}
