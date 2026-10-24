// Loans: each loan's details and its payment schedule (amortization), kept on the phone.
// A payment on a loan is saved as an expense for just the interest, which is the business expense, with the
// whole payment recorded on it (entry.loanPayment = { loanId, amount, scheduleN, source }). So payments go
// everywhere expenses do (the sheet, backups, Recently deleted) and the principal only lowers the balance.
// All the money math happens here, in code; the AI only says which loan a payment is for.

import { kvGet, kvSet } from './db.js';
import { settings, updateSettings } from './settings.js';
import { emit, formatMoney, parseISODate, round2, toISODate, uid } from './util.js';

export const FREQUENCIES = [
  { id: 'monthly', name: 'Monthly', months: 1 },
  { id: 'quarterly', name: 'Every 3 months', months: 3 },
  { id: 'semiannual', name: 'Twice a year', months: 6 },
  { id: 'annual', name: 'Once a year', months: 12 },
  { id: 'irregular', name: 'It varies', months: 0 },
];
const perYear = (frequency) => {
  const m = FREQUENCIES.find((f) => f.id === frequency)?.months;
  return m ? 12 / m : 0;
};

export const loansOn = () => settings().loans?.enabled === true;

// ---------- Storage ----------

export async function listLoans() {
  return (await kvGet('loans')) || [];
}

export async function getLoan(id) {
  return (await listLoans()).find((l) => l.id === id) || null;
}

export async function saveLoan(loan) {
  const all = await listLoans();
  const next = { ...loan, id: loan.id || uid(), updatedAt: Date.now(), createdAt: loan.createdAt || Date.now() };
  const i = all.findIndex((l) => l.id === next.id);
  if (i >= 0) all[i] = next; else all.push(next);
  await kvSet('loans', all);
  emit('loans-changed', { id: next.id });
  return next;
}

// The loan's payments stay as interest expenses; they're just no longer linked to a loan.
export async function deleteLoan(id) {
  await kvSet('loans', (await listLoans()).filter((l) => l.id !== id));
  emit('loans-changed', { id });
}

// Turns loan tracking on, making sure there's a category for the interest.
export async function turnOnLoans() {
  await updateSettings((d) => {
    d.loans = { ...d.loans, enabled: true };
    if (!d.categories.some((c) => /interest/i.test(c))) d.categories.push('Interest');
  });
}

export const interestCategory = () => settings().categories.find((c) => /interest/i.test(c)) || '';

// A new loan someone mentioned (by voice or typing), waiting for them to finish adding it.
export const listLoanDrafts = async () => (await kvGet('loanDrafts')) || [];
export async function addLoanDraft(draft) {
  await kvSet('loanDrafts', [...(await listLoanDrafts()), { ...draft, id: uid(), createdAt: Date.now() }]);
  emit('loans-changed', {});
}
export async function removeLoanDraft(id) {
  await kvSet('loanDrafts', (await listLoanDrafts()).filter((d) => d.id !== id));
  emit('loans-changed', {});
}

// ---------- Schedule ----------

function addMonths(iso, months) {
  const d = parseISODate(iso);
  if (!d) return '';
  const day = d.getDate();
  const t = new Date(d.getFullYear(), d.getMonth() + months, 1);
  t.setDate(Math.min(day, new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate()));
  return toISODate(t);
}

// The standard amortization schedule for a fixed-rate loan with regular payments:
// [{ n, date, payment, interest, principal, balance }]. Needs a number of payments or a payment amount.
export function buildSchedule({ amount, rate, frequency, count, firstDate, payment }) {
  const per = perYear(frequency);
  const principal0 = Number(amount) || 0;
  if (!per || principal0 <= 0 || !firstDate || (!(count > 0) && !(payment > 0))) return [];
  const r = (Number(rate) || 0) / 100 / per;
  let pay = Number(payment) || 0;
  if (!pay) pay = r ? (principal0 * r) / (1 - (1 + r) ** -count) : principal0 / count;
  pay = round2(pay);
  if (r && pay <= round2(principal0 * r)) return []; // the payment wouldn't even cover the interest
  const months = FREQUENCIES.find((f) => f.id === frequency).months;
  const rows = [];
  let balance = principal0;
  for (let n = 1; balance > 0.004 && n <= (count > 0 ? count : 1200); n++) {
    const interest = round2(balance * r);
    let part = round2(pay - interest);
    if (part > balance || (count > 0 && n === count)) part = round2(balance);
    balance = round2(balance - part);
    rows.push({ n, date: addMonths(firstDate, (n - 1) * months), payment: round2(interest + part), interest, principal: part, balance });
  }
  return rows;
}

// ---------- Payments and balances ----------

export const paymentsFor = (loanId, entries) => entries
  .filter((e) => e.loanPayment?.loanId === loanId)
  .sort((a, b) => a.fields.date.localeCompare(b.fields.date) || a.createdAt - b.createdAt);

// A payment's parts. The expense's amount is the interest, so editing it (in the app or the sheet) moves
// the rest of the payment to principal.
export function paymentParts(e) {
  const amount = round2(e.loanPayment.amount);
  const interest = round2(e.fields.total);
  return { amount, interest, principal: round2(amount - interest) };
}

export function loanStatus(loan, entries, year = new Date().getFullYear()) {
  const payments = paymentsFor(loan.id, entries);
  let principalPaid = 0;
  let interestPaid = 0;
  let interestThisYear = 0;
  for (const p of payments) {
    const parts = paymentParts(p);
    principalPaid += parts.principal;
    interestPaid += parts.interest;
    if (p.fields.date.startsWith(String(year))) interestThisYear += parts.interest;
  }
  const used = new Set(payments.map((p) => p.loanPayment.scheduleN).filter(Boolean));
  const next = (loan.schedule || []).find((r) => !used.has(r.n)) || null;
  return {
    payments,
    balance: round2(Math.max(0, (Number(loan.amount) || 0) - principalPaid)),
    principalPaid: round2(principalPaid),
    interestPaid: round2(interestPaid),
    interestThisYear: round2(interestThisYear),
    next,
  };
}

// How much of a payment is interest. Numbers from a statement come first, then the next row of the
// loan's schedule, then an estimate from the rate and the time since the last payment.
// Returns { interest, principal, source: 'statement'|'schedule'|'estimate'|'unknown', scheduleN }.
export function splitPayment(loan, { amount, date, statementInterest = -1, statementPrincipal = -1 }, entries) {
  const total = round2(amount);
  const clamp = (interest) => {
    const i = round2(Math.min(Math.max(0, interest), total));
    return { interest: i, principal: round2(total - i) };
  };
  const status = loanStatus(loan, entries);
  if (statementInterest >= 0) return { ...clamp(statementInterest), source: 'statement', scheduleN: status.next?.n || null };
  if (statementPrincipal >= 0) return { ...clamp(total - statementPrincipal), source: 'statement', scheduleN: status.next?.n || null };
  if (status.next) return { ...clamp(status.next.interest), source: 'schedule', scheduleN: status.next.n };
  const rate = Number(loan.rate) || 0;
  if (rate > 0 && status.balance > 0) {
    const last = status.payments.at(-1)?.fields.date || loan.startDate || '';
    const from = parseISODate(last);
    const to = parseISODate(date) || new Date();
    const per = perYear(loan.frequency);
    const days = from ? Math.max(0, Math.round((to - from) / 86_400_000)) : (per ? 365 / per : 30);
    return { ...clamp((status.balance * rate) / 100 * (days / 365)), source: 'estimate', scheduleN: null };
  }
  return { interest: 0, principal: total, source: 'unknown', scheduleN: null };
}

export const SPLIT_LABELS = {
  statement: 'from the statement',
  schedule: 'from the payment schedule',
  estimate: 'estimated from the rate',
  unknown: 'interest not known yet',
  manual: 'entered by hand',
};

// The expense fields for a payment (the interest part).
export function paymentFields(loan, interest) {
  return {
    vendor: loan.lender || loan.name,
    description: `${loan.name} interest`,
    total: round2(interest),
    category: interestCategory(),
  };
}

// ---------- For the accountant ----------

// Rows for a year-end report (or the sheet's loan tabs when year is null, meaning all time):
// { loans: [{ loan, startBalance, principal, interest, endBalance, count }], payments: [{ e, loan, parts, balanceAfter }] }.
export function loanReport(loans, entries, year = null) {
  const inYear = (iso) => year == null || iso.startsWith(String(year));
  const before = (iso) => year != null && iso < `${year}-01-01`;
  const summary = [];
  const payments = [];
  for (const loan of loans) {
    let balance = Number(loan.amount) || 0;
    let principal = 0;
    let interest = 0;
    let count = 0;
    let startBalance = balance;
    for (const e of paymentsFor(loan.id, entries)) {
      const parts = paymentParts(e);
      if (before(e.fields.date)) {
        balance = round2(balance - parts.principal);
        startBalance = balance;
        continue;
      }
      if (!inYear(e.fields.date)) continue;
      balance = round2(balance - parts.principal);
      principal += parts.principal;
      interest += parts.interest;
      count++;
      payments.push({ e, loan, parts, balanceAfter: Math.max(0, balance) });
    }
    summary.push({ loan, startBalance: Math.max(0, startBalance), principal: round2(principal), interest: round2(interest), endBalance: Math.max(0, round2(balance)), count });
  }
  payments.sort((a, b) => a.e.fields.date.localeCompare(b.e.fields.date));
  return { loans: summary, payments };
}

// ---------- For the AI ----------

// e.g. 'Tractor loan (lender: Farm Credit; they may call it "the John Deere loan")'
export function describeLoan(loan) {
  const bits = [loan.lender ? `lender: ${loan.lender}` : '', loan.aliases?.length ? `they may call it ${loan.aliases.map((a) => `"${a}"`).join(' or ')}` : ''].filter(Boolean);
  return bits.length ? `${loan.name} (${bits.join('; ')})` : loan.name;
}

// A short summary the live voice can use to answer questions like "how much do I still owe?".
export function loansSummary(loans, entries) {
  const cur = settings().currency;
  return loans.map((l) => {
    const st = loanStatus(l, entries);
    return `${l.name}: owes ${formatMoney(st.balance, cur)} of ${formatMoney(l.amount, cur)}; ${formatMoney(st.interestThisYear, cur)} interest paid this year`
      + (st.next ? `; next payment ${formatMoney(st.next.payment, cur)} due ${st.next.date}` : '');
  }).join('\n');
}

