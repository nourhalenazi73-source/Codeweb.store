'use strict';
const token = location.pathname.split('/').pop();
const root = $('#ord');
let timer = null, polls = 0, current = null;

async function view() {
  try { current = await api('/api/order/' + encodeURIComponent(token)); }
  catch (e) {
    root.innerHTML = `<h1>تعذّر عرض الطلب</h1><p class="sub">${esc(e.message)}</p><a class="btn" href="/">العودة إلى المتجر</a>`;
    return;
  }
  render(current);
  clearTimeout(timer);
  if (current.status === 'pending' && current.mode === 'moyasar' && polls++ < 200) timer = setTimeout(view, 4000);
}

function summary(o) {
  return `<div class="box">${o.items.map(i => `<div class="line"><span>${esc(i.title)} (${esc(i.label)}) × ${n(i.qty)}</span><b>${money(i.unit * i.qty)}</b></div>`).join('')}
  <div class="line" style="border-top:1px solid var(--line);margin-top:6px;padding-top:10px"><b>المجموع</b><b>${money(o.total)}</b></div></div>`;
}

function render(o) {
  const head = (t, s) => `<h1>${t}</h1><p class="sub">${s}</p>`;
  const back = '<a class="btn" href="/">العودة إلى المتجر</a>';
  if (o.status === 'paid') {
    try { localStorage.removeItem('codeweb-cart-v2'); } catch { /* تجاهل */ }
    let k = 0;
    root.innerHTML = head('تم الدفع، هذه أكوادك', `طلب رقم ${n(o.id)}${o.mailed ? ` · أرسلنا نسخة إلى ${esc(o.email)}` : ''}`) +
      o.items.map(i => `<div class="box"><h3>${esc(i.title)}</h3><p class="sub" style="margin:0">${esc(i.label)} × ${n(i.qty)}</p>
        <div class="codes">${i.codes.map(c => `<div class="codebox"><code>${esc(c)}</code><button data-copy="${k++}">نسخ</button></div>`).join('')}</div></div>`).join('') +
      '<p class="sub">احتفظ بالأكواد ولا تشاركها مع أحد. يمكنك العودة لهذه الصفحة من رابط الطلب في بريدك.</p>' + back;
    const all = o.items.flatMap(i => i.codes);
    root.querySelectorAll('[data-copy]').forEach(b => b.onclick = async () => {
      try { await navigator.clipboard.writeText(all[+b.dataset.copy]); toast('تم النسخ'); }
      catch { const code = b.previousElementSibling; const r = document.createRange(); r.selectNodeContents(code); const s = getSelection(); s.removeAllRanges(); s.addRange(r); toast('حدّد الكود وانسخه'); }
    });
    return;
  }
  if (o.status === 'pending') {
    const demo = o.mode === 'demo';
    root.innerHTML = head('بانتظار الدفع', `طلب رقم ${n(o.id)}`) + summary(o) +
      (demo
        ? '<div class="box demo"><b>وضع تجريبي</b><p class="sub" style="margin:4px 0 12px">لا يوجد دفع حقيقي. اضغط الزر لمحاكاة دفع ناجح واستلام أكواد تجريبية.</p><button class="btn" id="demoPay">محاكاة دفع ناجح</button></div>'
        : '<div class="box"><p class="sub" style="margin:0 0 12px">إذا أتممت الدفع فسيتحدّث طلبك تلقائيًا خلال لحظات.</p><button class="btn ghost" id="refresh">تحديث الحالة</button></div>') + back;
    const d = $('#demoPay'); if (d) d.onclick = async () => { d.disabled = true; try { await api('/api/demo-pay/' + encodeURIComponent(token), { method: 'POST', body: {} }); } catch (e) { toast(e.message); } view(); };
    const r = $('#refresh'); if (r) r.onclick = view;
    return;
  }
  if (o.status === 'needs_refund') {
    root.innerHTML = head('تم الدفع لكن الكمية نفدت', 'نعتذر عن ذلك. سنتواصل معك على بريدك لاسترجاع المبلغ كاملًا. احتفظ برقم الطلب: ' + n(o.id)) + summary(o) + back;
    return;
  }
  root.innerHTML = head(o.status === 'expired' ? 'انتهت مهلة الطلب' : 'تعذّر إتمام الطلب', 'لم يتم الدفع ولم يُخصم أي مبلغ. يمكنك إنشاء طلب جديد من المتجر.') + back;
}
view();
