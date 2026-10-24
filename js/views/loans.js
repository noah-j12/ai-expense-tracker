// Loans: the list, one loan's page, adding or editing a loan (from the lender's paperwork or its terms),
// recording a payment, and the year-end report for the accountant.

import { readLoanPaperwork } from '../ai.js';
import { getAllEntries } from '../db.js';
import { recordLoanPayment } from '../entries.js';
import { deliverFiles } from '../exporter.js';
import { prepareImage } from '../image.js';
import {
  FREQUENCIES, SPLIT_LABELS, buildSchedule, deleteLoan, getLoan, listLoanDrafts, listLoans, loanReport, loanStatus,
  loansOn, paymentParts, removeLoanDraft, saveLoan, splitPayment, turnOnLoans,
} from '../loans.js';
import { kick } from '../queue.js';
import { settings, updateSettings } from '../settings.js';
import { choiceSheet, confirmSheet, field, openSheet, toast, topbar } from '../ui.js';
import { fill, formatDate, formatMoney, h, icon, navBack, on, round2, toISODate } from '../util.js';
import { buildWorkbook } from '../xlsx.js';

const money = (n) => formatMoney(n, settings().currency);
const freqName = (id) => FREQUENCIES.find((f) => f.id === id)?.name || '';

export function LoansView({ params, query }) {
  const [id, sub] = params;
  if (id === 'new') return LoanForm({ draftId: query?.get('draft') });
  if (id && sub === 'edit') return LoanForm({ loanId: id });
  if (id) return LoanPage(id);
  return LoanList();
}

// ---------- The list ----------

function LoanList() {
  const el = h('div', { class: 'page' });
  const render = async () => {
    if (!loansOn()) {
      return fill(el, topbar({ title: 'Loans', back: () => navBack('#/') }),
        h('div', { class: 'card pad stack' },
          h('b', null, 'Keep track of your loans'),
          h('p', { class: 'small muted' }, 'Add each loan once, with its payment schedule. When you pay, just say or snap it: the interest is saved as an expense and the rest comes off the balance. At the end of the year there\'s a report for your accountant.'),
          h('button', { class: 'btn primary', onclick: async () => { await turnOnLoans(); render(); } }, 'Turn on loan tracking')));
    }
    const [loans, drafts, entries] = await Promise.all([listLoans(), listLoanDrafts(), getAllEntries()]);
    const year = new Date().getFullYear();
    fill(el,
      topbar({ title: 'Loans', back: () => navBack('#/') }),
      h('div', { class: 'stack' },
        drafts.map((d) => h('div', { class: 'banner' }, icon('sparkle'), h('div', { class: 'body' },
          h('b', null, 'You mentioned a new loan. '), d.said ? `"${d.said}"` : d.name,
          h('div', { class: 'row', style: { gap: '8px', marginTop: '6px' } },
            h('button', { class: 'btn small primary', onclick: () => { location.hash = `#/loans/new?draft=${d.id}`; } }, 'Finish adding it'),
            h('button', { class: 'btn small ghost', onclick: async () => { await removeLoanDraft(d.id); render(); } }, 'Dismiss'))))),
        loans.length
          ? h('div', { class: 'list' }, loans.map((l) => {
            const st = loanStatus(l, entries, year);
            return h('button', { class: 'list-item', onclick: () => { location.hash = `#/loans/${l.id}`; } }, icon('building'),
              h('div', { class: 'grow' }, h('div', null, l.name),
                h('div', { class: 'tiny muted' }, `Owes ${money(st.balance)}${st.next ? ` · next ${formatDate(st.next.date)}` : ''}`)),
              h('span', { class: 'chev' }, icon('chevron')));
          }))
          : h('div', { class: 'card pad muted small center' }, 'No loans yet.'),
        h('button', { class: 'btn primary block', onclick: () => { location.hash = '#/loans/new'; } }, icon('plus'), 'Add a loan'),
        loans.length ? h('button', { class: 'btn block', onclick: () => yearEndReport(loans) }, icon('download'), 'Year-end report for your accountant') : null,
        h('button', { class: 'btn ghost small', onclick: async () => {
          if (!(await confirmSheet({ title: 'Turn off loan tracking?', message: 'Your loans and their payments are kept. Turn it back on any time.', confirmText: 'Turn off' }))) return;
          await updateSettings((d) => { d.loans = { ...d.loans, enabled: false }; });
          render();
        } }, 'Turn off loan tracking'),
      ));
  };
  render();
  const offs = [on('loans-changed', render), on('entries-changed', render)];
  return { el, destroy: () => offs.forEach((off) => off()) };
}

async function yearEndReport(loans) {
  const now = new Date().getFullYear();
  const year = await choiceSheet({ title: 'Which year?', options: [now, now - 1, now - 2].map((y) => ({ label: String(y), value: y })) });
  if (!year) return;
  const r = loanReport(loans, await getAllEntries(), year);
  const t = (header, type = 'text') => ({ header, type });
  const file = buildWorkbook({
    dateFormat: settings().dateFormat,
    sheets: [
      {
        name: `Loans ${year}`,
        columns: [t('Loan'), t('Lender'), t('Interest rate'), t(`Balance on Jan 1`, 'money'), t('Principal paid', 'money'), t('Interest paid', 'money'), t(`Balance on Dec 31`, 'money'), t('Payments')],
        rows: r.loans.map((x) => [x.loan.name, x.loan.lender || '', x.loan.rate ? `${x.loan.rate}%` : '', x.startBalance, x.principal, x.interest, x.endBalance, String(x.count)]),
      },
      {
        name: `Payments ${year}`,
        columns: [t('Date', 'date'), t('Loan'), t('Payment', 'money'), t('Principal', 'money'), t('Interest', 'money'), t('Balance after', 'money'), t('Split'), t('Paid with')],
        rows: r.payments.map((p) => [p.e.fields.date, p.loan.name, p.parts.amount, p.parts.principal, p.parts.interest, p.balanceAfter, SPLIT_LABELS[p.e.loanPayment.source] || '', p.e.fields.paymentMethod || '']),
      },
    ],
  });
  await deliverFiles([new File([file], `Loans ${year}.xlsx`, { type: file.type })], `Loans ${year}`);
}

// ---------- One loan ----------

function LoanPage(id) {
  const el = h('div', { class: 'page' });
  const render = async () => {
    const loan = await getLoan(id);
    if (!loan) return fill(el, topbar({ title: 'Loan', back: () => navBack('#/loans') }), h('div', { class: 'card pad muted' }, 'This loan was deleted.'));
    const entries = await getAllEntries();
    const st = loanStatus(loan, entries);
    const paidPart = loan.amount ? Math.min(100, (st.principalPaid / loan.amount) * 100) : 0;
    const scheduleLine = loan.schedule?.length
      ? `${loan.schedule.length} payments, ${loan.scheduleSource === 'lender' ? 'from the lender\'s paperwork' : 'worked out from the loan\'s terms'}`
      : 'None yet, so interest is estimated from the rate';
    fill(el,
      topbar({ title: loan.name, back: () => navBack('#/loans') }),
      h('div', { class: 'stack' },
        h('div', { class: 'card pad stack', style: { gap: '6px' } },
          h('div', { class: 'small muted' }, 'Still owed'),
          h('div', { class: 'num', style: { fontSize: '28px', fontWeight: 700 } }, money(st.balance)),
          h('div', { class: 'meter' }, h('i', { style: { width: `${paidPart}%` } })),
          h('div', { class: 'tiny muted' }, `${money(st.principalPaid)} of ${money(loan.amount)} paid off · ${money(st.interestThisYear)} interest this year`),
          st.next ? h('div', { class: 'small' }, `Next payment ${formatDate(st.next.date)}: ${money(st.next.payment)} (${money(st.next.interest)} interest)`) : null),
        h('button', { class: 'btn primary block', onclick: () => paymentSheet(loan) }, icon('plus'), 'Record a payment'),
        h('div', { class: 'list' },
          h('div', { class: 'list-item' }, icon('clock'), h('div', { class: 'grow' }, h('div', null, 'Payment schedule'), h('div', { class: 'tiny muted' }, scheduleLine)),
            loan.schedule?.length ? h('button', { class: 'btn small', onclick: () => scheduleSheet(loan, st) }, 'View') : null),
          h('div', { class: 'list-item' }, icon('info'), h('div', { class: 'grow' }, h('div', null, [loan.lender, loan.rate ? `${loan.rate}% ${loan.rateType === 'variable' ? 'variable' : 'fixed'}` : '', freqName(loan.frequency)].filter(Boolean).join(' · ') || 'No details yet'))),
        ),
        h('div', { class: 'section-title' }, 'Payments'),
        st.payments.length
          ? h('div', { class: 'list' }, [...st.payments].reverse().map((p) => {
            const parts = paymentParts(p);
            return h('button', { class: 'list-item', onclick: () => { location.hash = `#/entry/${p.id}`; } },
              h('div', { class: 'grow' }, h('div', null, `${formatDate(p.fields.date)} · ${money(parts.amount)}`),
                h('div', { class: 'tiny muted' }, `${money(parts.principal)} principal · ${money(parts.interest)} interest · ${SPLIT_LABELS[p.loanPayment.source] || ''}`)),
              h('span', { class: 'chev' }, icon('chevron')));
          }))
          : h('div', { class: 'card pad muted small center' }, 'No payments yet. Record one here, or just say "paid $850 on the ' + loan.name.toLowerCase() + '".'),
        h('div', { class: 'spacer' }),
        h('button', { class: 'btn block', onclick: () => { location.hash = `#/loans/${loan.id}/edit`; } }, icon('pen'), 'Edit loan'),
        h('button', { class: 'btn danger block', onclick: async () => {
          if (!(await confirmSheet({ title: `Delete ${loan.name}?`, message: 'Its payments stay as interest expenses.', confirmText: 'Delete', danger: true }))) return;
          await deleteLoan(loan.id);
          location.hash = '#/loans';
        } }, 'Delete loan'),
      ));
  };
  render();
  const offs = [on('loans-changed', render), on('entries-changed', render)];
  return { el, destroy: () => offs.forEach((off) => off()) };
}

function scheduleSheet(loan, st) {
  const paid = new Set(st.payments.map((p) => p.loanPayment.scheduleN).filter(Boolean));
  openSheet((close) => h('div', { class: 'stack' },
    h('h3', null, 'Payment schedule'),
    h('div', { class: 'schedule' },
      h('div', { class: 'schedule-row head' }, h('span', null, '#'), h('span', null, 'Date'), h('span', null, 'Payment'), h('span', null, 'Interest'), h('span', null, 'Balance')),
      loan.schedule.map((r) => h('div', { class: 'schedule-row' + (paid.has(r.n) ? ' paid' : '') },
        h('span', null, paid.has(r.n) ? icon('check') : String(r.n)), h('span', null, formatDate(r.date)), h('span', null, money(r.payment)), h('span', null, money(r.interest)), h('span', null, money(r.balance))))),
    h('button', { class: 'btn block', onclick: close }, 'Done')));
}

function paymentSheet(loan) {
  (async () => {
    const entries = await getAllEntries();
    const st = loanStatus(loan, entries);
    const date = h('input', { class: 'input', type: 'date', value: toISODate() });
    const amount = h('input', { class: 'input', inputmode: 'decimal', value: st.next ? st.next.payment.toFixed(2) : (loan.payment ? Number(loan.payment).toFixed(2) : ''), placeholder: '0.00' });
    const interest = h('input', { class: 'input', inputmode: 'decimal', placeholder: 'Only if your statement shows it' });
    const methods = settings().paymentMethods;
    const paidWith = h('select', { class: 'select' }, h('option', { value: '' }, 'Not specified'), methods.map((m) => h('option', { value: m }, m)));
    const preview = h('div', { class: 'small muted' });
    const num = (input) => (input.value.trim() === '' ? -1 : round2(parseFloat(input.value.replace(/[^0-9.]/g, '')) || 0));
    const update = () => {
      const a = num(amount);
      if (a <= 0) return fill(preview, '');
      const s = splitPayment(loan, { amount: a, date: date.value, statementInterest: num(interest) }, entries);
      fill(preview, `${money(s.interest)} interest (saved as an expense) and ${money(s.principal)} off the balance, ${SPLIT_LABELS[num(interest) >= 0 ? 'statement' : s.source]}.`);
    };
    [date, amount, interest].forEach((i) => i.addEventListener('input', update));
    update();
    openSheet((close) => h('div', { class: 'stack' },
      h('h3', null, `Payment on ${loan.name}`),
      h('div', { class: 'grid-2' }, field('Date', date), field('Amount paid', amount)),
      field('Interest (optional)', interest),
      field('Paid with', paidWith),
      preview,
      h('button', { class: 'btn primary block', onclick: async () => {
        const a = num(amount);
        if (a <= 0) return toast('Enter the amount paid.', { error: true });
        await recordLoanPayment(loan, { date: date.value || toISODate(), amount: a, interest: num(interest), paymentMethod: paidWith.value });
        close();
        kick();
        toast('Payment saved');
      } }, 'Save payment'),
      h('button', { class: 'btn ghost block', onclick: close }, 'Cancel')));
  })();
}

// ---------- Adding or editing a loan ----------

function LoanForm({ loanId = null, draftId = null }) {
  const el = h('div', { class: 'page' });
  let loan = { name: '', lender: '', aliases: [], amount: 0, rate: 0, rateType: 'fixed', frequency: 'monthly', firstDate: '', count: 0, payment: 0, schedule: [], scheduleSource: '' };
  let busy = '';

  const inputs = {
    name: h('input', { class: 'input', placeholder: 'e.g. Tractor loan', autocapitalize: 'words' }),
    lender: h('input', { class: 'input', placeholder: 'e.g. the bank or company', autocapitalize: 'words' }),
    aliases: h('input', { class: 'input', placeholder: 'e.g. the John Deere loan', autocapitalize: 'none' }),
    amount: h('input', { class: 'input', inputmode: 'decimal', placeholder: '0.00' }),
    rate: h('input', { class: 'input', inputmode: 'decimal', placeholder: 'e.g. 6.5' }),
    rateType: h('select', { class: 'select' }, h('option', { value: 'fixed' }, 'Fixed'), h('option', { value: 'variable' }, 'Can change')),
    frequency: h('select', { class: 'select' }, FREQUENCIES.map((f) => h('option', { value: f.id }, f.name))),
    firstDate: h('input', { class: 'input', type: 'date' }),
    count: h('input', { class: 'input', inputmode: 'numeric', placeholder: 'e.g. 60' }),
    payment: h('input', { class: 'input', inputmode: 'decimal', placeholder: 'Worked out if left empty' }),
  };
  const fileInput = h('input', { type: 'file', accept: 'image/*,application/pdf', multiple: true, hidden: true });

  const toInputs = () => {
    inputs.name.value = loan.name || '';
    inputs.lender.value = loan.lender || '';
    inputs.aliases.value = (loan.aliases || []).join(', ');
    inputs.amount.value = loan.amount ? Number(loan.amount).toFixed(2) : '';
    inputs.rate.value = loan.rate || '';
    inputs.rateType.value = loan.rateType || 'fixed';
    inputs.frequency.value = loan.frequency || 'monthly';
    inputs.firstDate.value = loan.firstDate || '';
    inputs.count.value = loan.count || '';
    inputs.payment.value = loan.payment ? Number(loan.payment).toFixed(2) : '';
  };
  const n = (v) => parseFloat(String(v).replace(/[^0-9.]/g, '')) || 0;
  const fromInputs = () => ({
    ...loan,
    name: inputs.name.value.trim(),
    lender: inputs.lender.value.trim(),
    aliases: inputs.aliases.value.split(',').map((a) => a.trim()).filter(Boolean),
    amount: round2(n(inputs.amount.value)),
    rate: n(inputs.rate.value),
    rateType: inputs.rateType.value,
    frequency: inputs.frequency.value,
    firstDate: inputs.firstDate.value,
    count: Math.round(n(inputs.count.value)),
    payment: round2(n(inputs.payment.value)),
  });

  fileInput.addEventListener('change', async () => {
    const files = [...(fileInput.files || [])];
    if (!files.length) return;
    loan = fromInputs();
    busy = 'Reading the paperwork…';
    render();
    try {
      const ready = await Promise.all(files.map(async (f) => (f.type.startsWith('image/') ? (await prepareImage(f)).blob : f)));
      const out = await readLoanPaperwork(ready);
      const d = out.details;
      const rows = (out.schedule || []).filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date)).map((r, i) => ({ n: i + 1, date: r.date, payment: round2(r.payment), interest: round2(r.interest), principal: round2(r.principal), balance: round2(r.balance) }));
      // Fill in anything not already typed.
      loan = {
        ...loan,
        lender: loan.lender || d.lender || '',
        amount: loan.amount || d.amount || (rows[0] ? round2(rows[0].balance + rows[0].principal) : 0),
        rate: loan.rate || d.rate || 0,
        rateType: d.rate_type || loan.rateType,
        frequency: d.frequency || loan.frequency,
        firstDate: loan.firstDate || d.first_payment_date || rows[0]?.date || '',
        count: loan.count || d.payment_count || rows.length || 0,
        payment: loan.payment || d.payment_amount || rows[0]?.payment || 0,
      };
      if (rows.length) {
        loan.schedule = rows;
        loan.scheduleSource = 'lender';
      }
      toast(rows.length ? `Read ${rows.length} payments from the schedule` : 'Read the loan details. No payment schedule was shown.');
    } catch (err) {
      toast(err.message, { error: true });
    }
    busy = '';
    toInputs();
    render();
  });

  async function save() {
    const next = fromInputs();
    if (!next.name) return toast('Give the loan a name.', { error: true });
    if (!next.amount) return toast('Enter the amount borrowed.', { error: true });
    if (next.scheduleSource !== 'lender') {
      next.schedule = next.frequency === 'irregular' ? [] : buildSchedule(next);
      next.scheduleSource = next.schedule.length ? 'calculated' : '';
    }
    const saved = await saveLoan(next);
    if (draftId) await removeLoanDraft(draftId);
    toast(saved.schedule.length ? `Saved, with ${saved.schedule.length} payments in its schedule` : 'Saved');
    location.hash = `#/loans/${saved.id}`;
  }

  function render() {
    const title = loanId ? 'Edit loan' : 'Add a loan';
    if (busy) return fill(el, topbar({ title, back: () => navBack('#/loans') }), h('div', { class: 'row small muted' }, h('span', { class: 'spinner' }), busy));
    const scheduleNote = loan.scheduleSource === 'lender'
      ? h('div', { class: 'banner ok' }, icon('check'), h('div', { class: 'body' }, `Using the lender's schedule: ${loan.schedule.length} payments.`,
        h('div', null, h('button', { class: 'btn small ghost', onclick: () => { loan = { ...fromInputs(), schedule: [], scheduleSource: '' }; render(); } }, 'Work it out from the numbers instead'))))
      : h('p', { class: 'small muted', style: { margin: '0 4px' } }, 'With the amount, rate, how often, first payment date and either the number of payments or the payment amount, the app works out the schedule. If your lender gave you one, read it instead so it matches exactly.');
    fill(el,
      topbar({ title, back: () => navBack(loanId ? `#/loans/${loanId}` : '#/loans') }),
      h('div', { class: 'stack' },
        h('button', { class: 'btn block', onclick: () => fileInput.click() }, icon('camera'), "Read the lender's paperwork"),
        h('p', { class: 'tiny muted', style: { margin: '-6px 4px 0' } }, 'A photo or PDF of the payment schedule (amortization schedule), a statement or the loan agreement. It fills in what it finds.'),
        fileInput,
        scheduleNote,
        field('Name', inputs.name, 'What you call it when you talk to the app.'),
        field('Lender (optional)', inputs.lender),
        field('Other names you might say (optional)', inputs.aliases, 'Separate them with commas.'),
        h('div', { class: 'grid-2' }, field('Amount borrowed', inputs.amount), field('Interest rate (%)', inputs.rate)),
        h('div', { class: 'grid-2' }, field('Rate', inputs.rateType), field('How often you pay', inputs.frequency)),
        h('div', { class: 'grid-2' }, field('First payment', inputs.firstDate), field('Number of payments', inputs.count)),
        field('Payment amount (optional)', inputs.payment),
        h('button', { class: 'btn primary block', onclick: save }, 'Save loan'),
      ));
  }

  (async () => {
    if (loanId) loan = { ...loan, ...(await getLoan(loanId)) };
    if (draftId) {
      const d = (await listLoanDrafts()).find((x) => x.id === draftId);
      if (d) loan = { ...loan, name: d.name || '', lender: d.lender || '', amount: d.amount || 0, rate: d.rate || 0, frequency: d.frequency || 'monthly', firstDate: d.firstDate || '', count: d.count || 0, payment: d.payment || 0 };
    }
    toInputs();
    render();
  })();
  return { el };
}
