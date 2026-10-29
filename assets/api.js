// طبقة البيانات: Supabase لو الإعدادات موجودة، وإلا وضع تجريبي محلي
(function () {
  const C = window.FAZ3A_CONFIG || {};
  const DEMO = !C.SUPABASE_URL || !C.SUPABASE_ANON_KEY;

  const todayStr = () => {
    const d = new Date();
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    return d.toISOString().slice(0, 10);
  };
  const daysBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000) + 1;
  const digits = (s) => String(s || "").replace(/\D/g, "");

  const U = {
    DEMO, todayStr, daysBetween, digits,
    money: (n) => Number(n || 0).toFixed(3) + " " + (C.CURRENCY || "ر.ع"),
    esc: (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])),
    waPhone: (p) => { let d = digits(p); if (d.length === 8) d = "968" + d; return d; },
    waLink: (num, text) => "https://wa.me/" + digits(num) + "?text=" + encodeURIComponent(text),
    fmtDate: (s) => { try { return new Date(s + "T00:00:00").toLocaleDateString("ar-OM", { weekday: "short", day: "numeric", month: "short" }); } catch (e) { return s; } },
    STATUS: {
      pending:   { label: "بانتظار الموافقة", tone: "warn" },
      approved:  { label: "مقبول — جاهز للاستلام", tone: "info" },
      delivered: { label: "مع الطالب", tone: "accent" },
      returned:  { label: "تم الإرجاع", tone: "ok" },
      rejected:  { label: "مرفوض", tone: "bad" },
      cancelled: { label: "ملغي", tone: "muted" },
    },
  };
  window.FU = U;

  // ---------------- Supabase ----------------
  if (!DEMO) {
    const sb = window.supabase.createClient(C.SUPABASE_URL, C.SUPABASE_ANON_KEY);
    const ok = ({ data, error }) => { if (error) throw new Error(error.message); return data; };
    window.API = {
      listItems: async (s, e) => ok(await sb.rpc("items_availability", { p_start: s, p_end: e })),
      createBooking: async (b) => ok(await sb.rpc("create_booking", {
        p_item: b.item_id, p_qty: b.qty, p_start: b.start_date, p_end: b.end_date,
        p_name: b.student_name, p_student_id: b.student_id, p_phone: b.phone, p_notes: b.notes || "",
      })),
      trackBooking: async (code, phone) => ok(await sb.rpc("track_booking", { p_code: code, p_phone: phone })),

      session: async () => {
        const { data } = await sb.auth.getSession();
        const email = data.session?.user?.email;
        if (!email) return null;
        const isAdmin = ok(await sb.rpc("is_admin"));
        return { email, isAdmin };
      },
      signIn: async (email, password) => { ok(await sb.auth.signInWithPassword({ email, password })); },
      signOut: async () => { await sb.auth.signOut(); },
      adminBookings: async () => ok(await sb.from("bookings").select("*, item:items(name, icon)").order("created_at", { ascending: false }).limit(1000)),
      updateBooking: async (id, patch) => ok(await sb.from("bookings").update(patch).eq("id", id).select().single()),
      adminItems: async () => ok(await sb.from("items").select("*").order("sort").order("name")),
      saveItem: async (it) => {
        const row = { name: it.name, description: it.description, icon: it.icon, price_per_day: it.price_per_day,
          deposit: it.deposit, total_qty: it.total_qty, active: it.active, sort: it.sort };
        if (it.id) return ok(await sb.from("items").update(row).eq("id", it.id).select().single());
        return ok(await sb.from("items").insert(row).select().single());
      },
      deleteItem: async (id) => {
        const r = await sb.from("items").delete().eq("id", id);
        if (r.error) throw new Error(r.error.code === "23503" ? "ما تقدر تحذف أداة عليها حجوزات — عطّلها بدال" : r.error.message);
      },
    };
    return;
  }

  // ---------------- وضع تجريبي (localStorage) ----------------
  const mem = {};
  const store = {
    get(k, d) { if (k in mem) return mem[k]; try { const v = localStorage.getItem("faz3a_" + k); if (v) return (mem[k] = JSON.parse(v)); } catch (e) {} return d; },
    set(k, v) { mem[k] = v; try { localStorage.setItem("faz3a_" + k, JSON.stringify(v)); } catch (e) {} },
  };
  const uid = () => Math.random().toString(36).slice(2, 10);
  const SEED = [
    ["آلة حاسبة علمية", "Casio fx-991 — مسموحة في أغلب الامتحانات", "🧮", 0.2, 1, 5],
    ["كيبل Type-C", "كيبل شحن سريع 1 متر", "🔌", 0.1, 0.5, 6],
    ["شاحن جوال", "رأس شاحن 20W مع كيبل", "⚡", 0.2, 1, 4],
    ["باور بانك", "10,000 mAh", "🔋", 0.3, 2, 3],
    ["سماعات", "سماعات سلكية للمحاضرات المسجّلة", "🎧", 0.2, 1, 3],
    ["أدوات هندسية", "مسطرة + فرجار + منقلة", "📐", 0.1, 0.5, 4],
    ["كيبل HDMI", "للعروض والبريزنتيشن", "🖥️", 0.2, 1, 2],
  ].map(([name, description, icon, price_per_day, deposit, total_qty], i) =>
    ({ id: "it" + i, name, description, icon, price_per_day, deposit, total_qty, active: true, sort: i + 1 }));

  const items = () => store.get("items", null) || (store.set("items", SEED), SEED);
  const bookings = () => store.get("bookings", []);
  const booked = (itemId, s, e, list = bookings()) => list
    .filter((b) => b.item_id === itemId && ["pending", "approved", "delivered"].includes(b.status)
      && b.start_date <= e && (b.end_date >= s || b.status === "delivered"))
    .reduce((a, b) => a + b.qty, 0);
  const wait = (v) => new Promise((r) => setTimeout(() => r(v), 150));

  window.API = {
    listItems: async (s, e) => wait(items().filter((i) => i.active).sort((a, b) => a.sort - b.sort)
      .map((i) => ({ ...i, available: Math.max(i.total_qty - booked(i.id, s, e), 0) }))),
    createBooking: async (b) => {
      const it = items().find((i) => i.id === b.item_id && i.active);
      if (!it) throw new Error("الأداة غير متوفرة");
      if (b.start_date < todayStr()) throw new Error("تاريخ الاستلام لازم يكون اليوم أو بعده");
      if (b.end_date < b.start_date) throw new Error("تاريخ الإرجاع قبل تاريخ الاستلام");
      if (daysBetween(b.start_date, b.end_date) > 30) throw new Error("أقصى مدة للحجز 30 يوم");
      if (!(b.qty >= 1 && b.qty <= 5)) throw new Error("الكمية لازم تكون من 1 إلى 5");
      if (!b.student_name?.trim() || !b.student_id?.trim() || !b.phone?.trim()) throw new Error("عبّ الاسم والرقم الجامعي ورقم الهاتف");
      const avail = it.total_qty - booked(it.id, b.start_date, b.end_date);
      if (avail < b.qty) throw new Error("الكمية المطلوبة غير متوفرة في هذي الفترة (المتوفر: " + Math.max(avail, 0) + ")");
      const total = +(it.price_per_day * daysBetween(b.start_date, b.end_date) * b.qty).toFixed(3);
      const code = Array.from({ length: 6 }, () => "ABCDEFGHJKMNPQRSTUVWXYZ23456789"[Math.floor(Math.random() * 31)]).join("");
      const list = bookings();
      list.unshift({ id: uid(), code, ...b, notes: b.notes || "", status: "pending", total_price: total, admin_note: "",
        created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
      store.set("bookings", list);
      return wait({ code, total });
    },
    trackBooking: async (code, phone) => {
      const b = bookings().find((x) => x.code === code.trim().toUpperCase() && digits(x.phone).slice(-8) === digits(phone).slice(-8));
      if (!b) return wait(null);
      const it = items().find((i) => i.id === b.item_id) || {};
      return wait({ code: b.code, status: b.status, item: it.name, icon: it.icon, qty: b.qty, start_date: b.start_date,
        end_date: b.end_date, total: b.total_price, admin_note: b.admin_note });
    },

    session: async () => { const e = store.get("demo_admin", null); return e ? { email: e, isAdmin: true } : null; },
    signIn: async (email) => { store.set("demo_admin", email || "demo@faz3a"); },
    signOut: async () => { store.set("demo_admin", null); },
    adminBookings: async () => {
      const its = items();
      return wait(bookings().map((b) => ({ ...b, item: its.find((i) => i.id === b.item_id) || { name: "؟", icon: "📦" } })));
    },
    updateBooking: async (id, patch) => {
      const list = bookings(); const b = list.find((x) => x.id === id);
      Object.assign(b, patch, { updated_at: new Date().toISOString() }); store.set("bookings", list); return wait(b);
    },
    adminItems: async () => wait([...items()].sort((a, b) => a.sort - b.sort)),
    saveItem: async (it) => {
      const list = items();
      if (it.id) Object.assign(list.find((x) => x.id === it.id), it);
      else list.push({ ...it, id: uid() });
      store.set("items", list); return wait(it);
    },
    deleteItem: async (id) => {
      if (bookings().some((b) => b.item_id === id)) throw new Error("ما تقدر تحذف أداة عليها حجوزات — عطّلها بدال");
      store.set("items", items().filter((i) => i.id !== id));
    },
  };
})();
