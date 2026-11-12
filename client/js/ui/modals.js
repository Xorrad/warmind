/**
 * @file Popups: add task, settings, action confirmations.
 */

import { TASKS } from '/engine/config.js';
import { validateTask } from '/engine/tasks.js';

/** Value for a datetime-local input, in local time. */
function toLocalInput(date) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Add days or months to a date, keeping the time of day. Adding a month to
 * the 31st lands on the last day of a shorter month instead of spilling over.
 * @param {Date} date
 * @param {{ days?: number, months?: number }} delta
 * @returns {Date}
 */
export function addToDate(date, { days = 0, months = 0 }) {
    const d = new Date(date);
    if (months) {
        const day = d.getDate();
        d.setDate(1);
        d.setMonth(d.getMonth() + months);
        const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
        d.setDate(Math.min(day, lastDay));
    }
    d.setDate(d.getDate() + days);
    return d;
}

/**
 * Wire the add/edit task dialog.
 * @param {HTMLDialogElement} dialog
 * @param {(fields: import('/engine/tasks.js').TaskFields, id: string|null) => void} onSave
 * @returns {{ open: (task?: import('/engine/tasks.js').Task|null, kind?: 'once'|'daily') => void }}
 */
export function createTaskDialog(dialog, onSave) {
    const form = dialog.querySelector('form');
    const fields = form.elements;
    const heading = dialog.querySelector('[data-heading]');
    const dueRow = dialog.querySelector('[data-due-row]');
    let editingId = null;

    // Due date shortcuts push the current due date back (they stack); with
    // no date set they count from tonight 23:59
    for (const button of dialog.querySelectorAll('[data-add-days], [data-add-months]')) {
        button.addEventListener('click', () => {
            let from = fields.dueAt.value ? new Date(fields.dueAt.value) : null;
            if (!from || Number.isNaN(from.getTime())) {
                from = new Date();
                from.setHours(23, 59, 0, 0);
            }
            const delta = { days: Number(button.dataset.addDays ?? 0), months: Number(button.dataset.addMonths ?? 0) };
            fields.dueAt.value = toLocalInput(addToDate(from, delta));
        });
    }

    const severityOut = dialog.querySelector('[data-severity-value]');
    const syncSeverity = () => (severityOut.textContent = `${fields.severity.value} / ${TASKS.severity.max}`);
    fields.severity.addEventListener('input', syncSeverity);

    const syncKind = () => {
        const daily = fields.kind.value === 'daily';
        dueRow.hidden = daily;
        fields.dueAt.required = !daily;
    };
    for (const radio of fields.kind) radio.addEventListener('change', syncKind);

    function showErrors(errors) {
        for (const out of dialog.querySelectorAll('[data-error]')) {
            out.textContent = errors[out.dataset.error] ?? '';
        }
        const first = Object.keys(errors)[0];
        if (first) fields[first]?.focus?.();
    }

    form.addEventListener('submit', (e) => {
        if (e.submitter?.value === 'cancel') return; // let the dialog close
        e.preventDefault();
        const recurring = fields.kind.value === 'daily';
        const values = {
            title: fields.title.value,
            severity: Number(fields.severity.value),
            recurring,
            dueAt: recurring || !fields.dueAt.value ? null : new Date(fields.dueAt.value).toISOString(),
        };
        const errors = validateTask(values);
        showErrors(errors);
        if (Object.keys(errors).length) return;
        onSave(values, editingId);
        dialog.close();
    });

    return {
        open(task = null, kind = 'once') {
            editingId = task?.id ?? null;
            heading.textContent = task ? 'Edit task' : kind === 'daily' ? 'New daily task' : 'New task';
            const defaultDue = new Date();
            defaultDue.setDate(defaultDue.getDate() + 1);
            defaultDue.setHours(23, 59, 0, 0);
            fields.title.value = task?.title ?? '';
            fields.kind.value = task ? (task.recurring ? 'daily' : 'once') : kind;
            fields.dueAt.value = toLocalInput(task?.dueAt ? new Date(task.dueAt) : defaultDue);
            fields.severity.value = String(task?.severity ?? 3);
            syncKind();
            syncSeverity();
            showErrors({});
            dialog.showModal();
            fields.title.focus();
        },
    };
}
