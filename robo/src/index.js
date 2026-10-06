/* Robô do km — Guimas Car
   Pede pelo WhatsApp a foto do painel aos motoristas LIGADOS na tela "📸 Robô do km" do Gestão,
   lê o hodômetro (Gemini), responde quanto falta para óleo e correia e devolve a leitura ao Gestão.

   SEGURANÇA: o robô só conhece a área isolada familias/<ROBO_ID>. Ele não tem a chave do Gestão,
   não lê contratos, CPFs nem financeiro. O Gestão exporta para lá só nome, telefone, carro, km e
   próximas trocas, e é o Gestão (não o robô) que aplica a leitura no carro.
   Segredos (Cloudflare → Settings → Variables and Secrets): ROBO_ID e WA_KEY (GEMINI_KEY é opcional:
   sem ela, a foto é lida pela IA da própria Cloudflare).
   Este arquivo é público no GitHub: nada de segredo aqui. */

const VERSAO = 'robo-km 3.8';
const DIA = 864e5;

/* ---------------- utilidades ---------------- */
const num = (v, d = 0) => (v === undefined || v === null || v === '' || isNaN(Number(v))) ? d : Number(v);
const fmtKm = n => Math.round(n).toLocaleString('pt-BR');
const agoraBRT = (t = Date.now()) => new Date(t - 3 * 3600e3);              /* Brasil sem horário de verão */
const dataBRT = t => agoraBRT(t).toISOString().slice(0, 10);
const primeiroNome = n => { const p = String(n || '').trim().split(/\s+/)[0] || ''; return p ? p[0].toUpperCase() + p.slice(1).toLowerCase() : ''; };
function saudacao(t = Date.now()) { const h = agoraBRT(t).getUTCHours(); return h < 12 ? 'bom dia' : (h < 18 ? 'boa tarde' : 'boa noite'); }
function fmtPlaca(p) { p = String(p || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); return p.length === 7 ? p.slice(0, 3) + '-' + p.slice(3) : p; }

/* Telefone BR: chave = DDD + 8 últimos dígitos (o WhatsApp às vezes manda o número sem o 9). */
function foneDigitos(t) {
  let d = String(t || '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('55') && d.length >= 12) d = d.slice(2);
  d = d.replace(/^0+/, '');
  return d.length >= 10 && d.length <= 11 ? d : '';
}
function foneChave(t) { const d = foneDigitos(t); return d ? d.slice(0, 2) + d.slice(-8) : ''; }
function foneEnvio(t) {
  const d = foneDigitos(t); if (!d) return '';
  return '55' + (d.length === 10 && /[6-9]/.test(d[2]) ? d.slice(0, 2) + '9' + d.slice(2) : d);
}

/* ---------------- contexto ---------------- */
class Ctx {
  constructor(env) {
    this.env = env; this.sub = 0; this.tok = null;
    this.db = env.FIREBASE_DB || 'https://guimas-73e01-default-rtdb.firebaseio.com';
    const id = String(env.ROBO_ID || '').trim();
    if (!/^[0-9a-f]{64}$/.test(id)) throw new Error('Segredo ROBO_ID ausente ou inválido');
    this.base = `familias/${id}`;
  }
  async f(url, opt) { this.sub++; return fetch(url, opt); }
  async token() {
    if (this.tok) return this.tok;
    const g = globalThis.__fbTok;
    if (g && g.exp > Date.now() + 60e3) return (this.tok = g.t);
    const r = await this.f('https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=' + this.env.FIREBASE_API_KEY, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"returnSecureToken":true}'
    });
    const j = await r.json();
    if (!j.idToken) throw new Error('Firebase auth: ' + JSON.stringify(j).slice(0, 200));
    globalThis.__fbTok = { t: j.idToken, exp: Date.now() + (num(j.expiresIn, 3600) - 120) * 1000 };
    return (this.tok = j.idToken);
  }
  async fb(metodo, caminho, corpo) {
    const url = `${this.db}/${this.base}${caminho ? '/' + caminho : ''}.json?auth=${await this.token()}`;
    const r = await this.f(url, { method: metodo, headers: { 'content-type': 'application/json' }, body: corpo === undefined ? undefined : JSON.stringify(corpo) });
    if (!r.ok) throw new Error(`Firebase ${metodo} ${caminho}: ${r.status} ${(await r.text()).slice(0, 200)}`);
    return r.json();
  }
  get(c) { return this.fb('GET', c); }
  patch(c, v) { return this.fb('PATCH', c, v); }
  put(c, v) { return this.fb('PUT', c, v); }
  post(c, v) { return this.fb('POST', c, v); }
  log(erro) { return this.post('erros', { em: Date.now(), erro: String(erro).slice(0, 300) }).catch(() => { }); }

  /* ---------- WhatsApp (Dualhook ou Graph API da Meta: mesmo formato) ---------- */
  get waBase() { return (this.env.WA_BASE || 'https://api.dualhook.com/v25.0').replace(/\/$/, ''); }
  async wa(caminho, corpo) {
    const r = await this.f(`${this.waBase}/${caminho}`, {
      method: corpo ? 'POST' : 'GET',
      headers: { authorization: 'Bearer ' + this.env.WA_KEY, 'content-type': 'application/json' },
      body: corpo ? JSON.stringify(corpo) : undefined
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`WhatsApp ${r.status}: ${JSON.stringify(j.error || j).slice(0, 250)}`);
    return j;
  }
  texto(para, body) {
    return this.wa(`${this.env.PHONE_NUMBER_ID}/messages`, { messaging_product: 'whatsapp', to: para, type: 'text', text: { body, preview_url: false } });
  }
  modelo(para, params) {
    return this.wa(`${this.env.PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp', to: para, type: 'template',
      template: { name: MODELO.name, language: { code: MODELO.language },
        components: [{ type: 'body', parameters: params.map(t => ({ type: 'text', text: String(t).slice(0, 60) })) }] }
    });
  }
  async baixarMidia(id) {
    const auth = { authorization: 'Bearer ' + this.env.WA_KEY };
    if (/dualhook/.test(this.waBase)) {
      const r = await this.f(`${this.waBase}/${id}/content`, { headers: auth });
      if (!r.ok) throw new Error('mídia ' + r.status);
      return { bytes: await r.arrayBuffer(), mime: r.headers.get('content-type') || 'image/jpeg' };
    }
    const meta = await this.wa(id);
    const r = await this.f(meta.url, { headers: auth });
    if (!r.ok) throw new Error('mídia ' + r.status);
    return { bytes: await r.arrayBuffer(), mime: meta.mime_type || 'image/jpeg' };
  }
}

/* ---------------- mensagens ---------------- */
/* Texto de entrada combinado com o Hudson (precisa de aprovação da Meta). */
const MODELO = {
  name: 'pedido_km_painel', language: 'pt_BR', category: 'UTILITY',
  components: [{
    type: 'BODY',
    text: 'Olá, *{{1}}*, {{2}}! 👋\n\nPor favor, me envie agora uma *foto nítida do painel* mostrando a *quilometragem* do *{{3}}*.\n\n🛢️ É para a *verificação da troca de óleo*.\n\nObrigado!\n*Guimas Car*',
    example: { body_text: [['Carlos', 'bom dia', 'Ka Sedan 2015 AZH-5D13']] }
  }]
};
function textoPedidoLivre(nome, carro, t) { return `Olá, *${nome}*, ${saudacao(t)}! 👋\n\nPor favor, me envie agora uma *foto nítida do painel* mostrando a *quilometragem* do *${carro}*.\n\n🛢️ É para a *verificação da troca de óleo*.\n\nObrigado!\n*Guimas Car*`; }
const MSG_ILEGIVEL = 'Não consegui ler a quilometragem nessa foto 🤔 Manda outra bem de perto do painel, com o km total aparecendo, por favor.';
const msgConferir = km => `Li ${fmtKm(km)} km, mas não bateu com o último registro do carro. Manda mais uma foto bem de perto do km total (não o TRIP), por favor.`;
/* Óleo: SEMPRE o original da montadora primeiro (regra do Hudson). A 2ª opção é a melhor marca
   fora da concessionária — de preferência a mesma fábrica que produz o original. */
const OLEO_MARCA = {
  FORD: { nome: 'Ford', orig: 'Motorcraft', alt: 'Mobil' },
  RENAULT: { nome: 'Renault', orig: 'Motrio', alt: 'Elf' },
  VW: { nome: 'Volkswagen', orig: 'Maxi Performance', alt: 'Shell Helix' },
  FIAT: { nome: 'Fiat', orig: 'Selenia', alt: 'Mobil' },
  JEEP: { nome: 'Jeep', orig: 'Selenia', alt: 'Mobil' },
  CHEVROLET: { nome: 'Chevrolet', orig: 'ACDelco', alt: 'Mobil' },
  NISSAN: { nome: 'Nissan', orig: 'Nissan', alt: 'Mobil' },
  TOYOTA: { nome: 'Toyota', orig: 'Toyota', alt: 'Mobil' },
  HONDA: { nome: 'Honda', orig: 'Honda', alt: 'Mobil' },
  HYUNDAI: { nome: 'Hyundai', orig: 'Hyundai', alt: 'Shell Helix' },
  KIA: { nome: 'Kia', orig: 'Kia', alt: 'Mobil' },
  PEUGEOT: { nome: 'Peugeot', orig: 'Total Quartz', alt: 'Mobil' },
  CITROEN: { nome: 'Citroën', orig: 'Total Quartz', alt: 'Mobil' },
  MITSUBISHI: { nome: 'Mitsubishi', orig: 'Mitsubishi', alt: 'Mobil' }
};
const MARCA_RE = [
  ['FORD', /\bFORD\b|\b(KA|FIESTA|ECOSPORT|FOCUS|RANGER|TERRITORY)\b/],
  ['RENAULT', /\bRENAULT\b|\b(LOGAN|SANDERO|KWID|DUSTER|CAPTUR|OROCH|STEPWAY)\b/],
  ['VW', /\b(VW|VOLKSWAGEN|VOLKS)\b|\b(GOL|VOYAGE|FOX|POLO|VIRTUS|UP|SAVEIRO|T-?CROSS|NIVUS|JETTA)\b/],
  ['FIAT', /\bFIAT\b|\b(UNO|MOBI|ARGO|CRONOS|SIENA|GRAND SIENA|PALIO|STRADA|TORO|PULSE|FASTBACK|DOBLO)\b/],
  ['JEEP', /\bJEEP\b|\b(RENEGADE|COMPASS|COMMANDER)\b/],
  ['CHEVROLET', /\b(CHEV|CHEVROLET|GM)\b|\b(ONIX|PRISMA|COBALT|SPIN|CELTA|CLASSIC|TRACKER|MONTANA|S10|CRUZE)\b/],
  ['NISSAN', /\bNISSAN\b|\b(VERSA|KICKS|MARCH|SENTRA|FRONTIER|LIVINA|TIIDA)\b/],
  ['TOYOTA', /\bTOYOTA\b|\b(COROLLA|ETIOS|YARIS|HILUX|SW4|COROLLA CROSS)\b/],
  ['HONDA', /\bHONDA\b|\b(FIT|CITY|CIVIC|HR-?V|WR-?V)\b/],
  ['HYUNDAI', /\bHYUNDAI\b|\b(HB20S?|CRETA)\b/],
  ['KIA', /\bKIA\b|\b(PICANTO|CERATO|SPORTAGE|SOUL)\b/],
  ['PEUGEOT', /\bPEUGEOT\b|\b(208|2008|308|408|3008)\b/],
  ['CITROEN', /\bCITROEN\b|\b(C3|C4|AIRCROSS|BASALT)\b/],
  ['MITSUBISHI', /\b(MITSUBISHI|MMC)\b|\b(LANCER|PAJERO|ASX|L200)\b/]
];
function marcaCarro(ct) {
  const sa = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/^I\//, '').replace(/\//g, ' ');
  /* CRLV primeiro ("FORD/KA SE 1.0", "CHEV/ONIX"…); só depois o apelido do carro no Gestão */
  for (const txt of [sa(ct.modelo), sa(ct.carro)]) {
    if (!txt) continue;
    const pre = txt.split(/\s+/)[0];
    for (const [k, re] of MARCA_RE) if (re.test(pre)) return k;
    for (const [k, re] of MARCA_RE) if (re.test(txt)) return k;
  }
  return '';
}
function linhaOleo(ct) {
  const mk = OLEO_MARCA[marcaCarro(ct)];
  const visc = ct.oleoTipo ? `*${ct.oleoTipo}* — ` : '';
  const igual = ct.oleoTipo ? ' na mesma viscosidade' : '';
  const orig = mk && (mk.orig === mk.nome ? `use o *original ${mk.orig}* (da concessionária)` : `use o original *${mk.orig}* (${mk.nome})`);
  return mk ? `🧴 Óleo: ${visc}${orig}. Se não tiver, *${mk.alt}*${igual}. Sempre com filtro novo.`
    : `🧴 Óleo: ${visc}use o *original da montadora*. Se não tiver, *Mobil*${igual}. Sempre com filtro novo.`;
}
const AVISO_CORREIA = 8000;
function textoResposta(ct, km, nome) {
  const L = [`✅ Recebi${nome ? ', ' + nome : ''}! Km registrado: *${fmtKm(km)}*`];
  const po = num(ct.proxOleoKm);
  if (po) {
    const f = po - km;
    /* troca de óleo é responsabilidade do motorista: só informa, sem "agendar" */
    L.push(f <= 0 ? `🛢 Troca de óleo: *VENCIDA há ${fmtKm(-f)} km*. Faça a troca o quanto antes.`
      : `🛢 Troca de óleo: faltam *${fmtKm(f)} km* (troca aos ${fmtKm(po)} km).`);
  }
  if (po) L.push(linhaOleo(ct));
  const pc = num(ct.proxCorreiaKm);
  if (ct.temCorreia && pc) {   /* carro com corrente de comando não recebe linha de correia */
    const f = pc - km;
    if (f <= 0) L.push(`⚙️ Correia dentada: *VENCIDA há ${fmtKm(-f)} km*. Me chama para agendarmos o quanto antes.`);
    else if (f <= AVISO_CORREIA) L.push(`⚠️ *Correia dentada: faltam ${fmtKm(f)} km* (troca aos ${fmtKm(pc)} km).`);   /* a partir de 8.000 km: destaque (regra do Hudson) */
    else L.push(`⚙️ Correia dentada: faltam *${fmtKm(f)} km* (troca aos ${fmtKm(pc)} km).`);
  }
  L.push('', '_Mensagem automática · Guimas Car_');
  return L.join('\n');
}

/* ---------------- leitura do hodômetro ---------------- */
const PROMPT = `Você recebe uma foto que deveria mostrar o PAINEL (quadro de instrumentos) de um carro.
Leia o HODÔMETRO TOTAL (ODO / quilometragem total do carro).
NUNCA use o hodômetro parcial (TRIP, TRIP A, TRIP B, "A", "B"), velocímetro, conta-giros, autonomia, temperatura, relógio ou consumo.
Se aparecerem dois números de km, o total é o maior e costuma vir rotulado ODO ou sem rótulo de TRIP.
Responda SOMENTE com JSON: {"painel": true|false, "odometro": inteiro ou null, "certeza": "alta"|"media"|"baixa", "obs": "texto curto"}.
"painel" = false se a foto não for de um painel de carro. "odometro" = null se não der para ler com segurança.`;

function b64(buf) {
  if (typeof Buffer !== 'undefined') return Buffer.from(buf).toString('base64');
  let s = ''; const u = new Uint8Array(buf);
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(s);
}
/* Leitura pela IA da própria Cloudflare (Workers AI, plano grátis): sem conta nem chave extra. */
const MODELOS_CF = ['@cf/meta/llama-4-scout-17b-16e-instruct', '@cf/mistralai/mistral-small-3.1-24b-instruct'];
async function lerOdometroCF(ctx, midia) {
  const url = `data:${midia.mime.split(';')[0]};base64,${b64(midia.bytes)}`;
  let ultimoErro = '';
  for (const m of [ctx.env.CF_MODEL, ...MODELOS_CF].filter(Boolean)) {
    try {
      const out = await ctx.env.AI.run(m, {
        messages: [{ role: 'user', content: [{ type: 'text', text: PROMPT }, { type: 'image_url', image_url: { url } }] }],
        max_tokens: 200, temperature: 0
      });
      const resp = out && (out.response !== undefined ? out.response : (out.choices && out.choices[0] && out.choices[0].message && out.choices[0].message.content));
      return interpretarResposta(typeof resp === 'string' ? resp : JSON.stringify(resp || {}));
    } catch (e) { ultimoErro += `${m}: ${String(e.message || e).slice(0, 200)} | `; }
  }
  throw new Error('Workers AI: ' + ultimoErro);
}
async function lerOdometro(ctx, midia) {
  if (!ctx.env.GEMINI_KEY && ctx.env.AI) return lerOdometroCF(ctx, midia);
  const modelos = [ctx.env.GEMINI_MODEL, 'gemini-flash-latest', 'gemini-flash-lite-latest'].filter(Boolean);
  const corpo = {
    contents: [{ parts: [{ text: PROMPT }, { inline_data: { mime_type: midia.mime.split(';')[0], data: b64(midia.bytes) } }] }],
    generationConfig: { temperature: 0, responseMimeType: 'application/json' }
  };
  let ultimoErro = '';
  for (const m of modelos) {
    const r = await ctx.f(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': ctx.env.GEMINI_KEY }, body: JSON.stringify(corpo)
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { ultimoErro = `${m}: ${r.status} ${JSON.stringify(j).slice(0, 200)}`; continue; }
    const txt = (((j.candidates || [])[0] || {}).content || {}).parts?.map(p => p.text || '').join('') || '';
    return interpretarResposta(txt);
  }
  throw new Error('Gemini: ' + ultimoErro);
}
function interpretarResposta(txt) {
  let o = {};
  try { o = JSON.parse(String(txt).replace(/```json|```/g, '').trim()); } catch (e) {
    const m = String(txt).match(/\{[\s\S]*\}/); if (m) { try { o = JSON.parse(m[0]); } catch (e2) { } }
  }
  let km = o.odometro;
  if (typeof km === 'string') km = Number(km.replace(/\D/g, ''));
  km = Number.isFinite(km) && km > 0 && km < 2e6 ? Math.round(km) : null;
  const certeza = String(o.certeza || '').toLowerCase();
  return { painel: o.painel !== false, km: certeza === 'baixa' ? null : km, certeza, obs: String(o.obs || '').slice(0, 200) };
}

/* Leitura da foto contra o último km conhecido (Gestão ou foto anterior aceita).
   Km MENOR que o registrado = foto antiga, de outro carro ou tentativa de enganar -> alerta ao Hudson.
   Km MUITO acima do possível no período = leitura errada -> alerta também. */
function avaliarLeitura(ct, m, km, agora) {
  let ref = num(ct.kmUltima), refData = ct.kmUltimaData || '';
  if (m && num(m.km) > ref) { ref = num(m.km); refData = m.leituraEm ? dataBRT(m.leituraEm) : refData; }
  if (!ref) return { ok: true };
  if (km < ref - 100) return { ok: false, tipo: 'regrediu', ref, refData };
  if (!plausivel({ ...ct, kmUltima: ref, kmUltimaData: refData }, km, agora)) return { ok: false, tipo: 'alto', ref, refData };
  return { ok: true, ref };
}
const MSG_AUDIO = nome => `Recebi seu áudio${nome ? ', ' + nome : ''}! 👍 Para eu registrar o km certinho, preciso da *foto do painel* com a *quilometragem* aparecendo. Pode mandar quando puder. 📸`;
const MSG_SUSPEITA = 'Recebi, obrigado! Esse km ficou diferente do registro do carro, então vou conferir e, se precisar, te chamo. 👍';
/* leitura plausível? (até o triplo do ritmo do carro, mínimo 800 km/dia, + folga de 5.000 km).
   Folgado de propósito: só barra erro grosseiro (dígito a mais/a menos); km menor que o registro é barrado sempre. */
function plausivel(ct, km, agora) {
  const ref = num(ct.kmUltima); if (!ref) return true;
  if (km < ref - 100) return false;
  const dr = /^\d{4}-\d{2}-\d{2}$/.test(ct.kmUltimaData || '') ? ct.kmUltimaData : '';
  const dias = dr ? Math.max(1, (agora - Date.parse(dr + 'T12:00:00-03:00')) / DIA) : 60;
  return km - ref <= Math.max(800, 3 * num(ct.kmDia)) * dias + 5000;
}

/* ---------------- quem precisa receber o pedido (regra combinada com o Hudson) ----------------
   Sem prazo fixo. Pede a foto só quando:
   (a) pela estimativa (último km + média de km/dia do carro × dias), a troca de óleo (ou da correia)
       provavelmente já chegou ou está a menos de MARGEM km; ou
   (b) não há como estimar: carro sem km registrado, ou sem média e com o último km há mais de 30 dias.
   Nunca pede para quem mandou km/foto há menos de 7 dias nem repete pedido em menos de 7 dias. */
const MARGEM_OLEO = 500, MARGEM_CORREIA = 1000, MIN_DIAS = 7, SEM_HIST_DIAS = 30;
function estimativa(ct, m, t) {
  let km = num(ct.kmUltima), tBase = /^\d{4}-\d{2}-\d{2}$/.test(ct.kmUltimaData || '') ? Date.parse(ct.kmUltimaData + 'T12:00:00-03:00') : 0;
  if (num(m && m.leituraEm) > tBase && num(m && m.km) > 0) { km = num(m.km); tBase = num(m.leituraEm); }
  const dias = tBase ? Math.max(0, (t - tBase) / DIA) : null, kmDia = num(ct.kmDia);
  const est = km && dias != null && kmDia ? km + kmDia * dias : (km || null);
  const fo = num(ct.proxOleoKm) && est ? num(ct.proxOleoKm) - est : null;
  const fc = ct.temCorreia && num(ct.proxCorreiaKm) && est ? num(ct.proxCorreiaKm) - est : null;
  return { km, tBase, dias, kmDia, est, fo, fc };
}
function precisaPedir(ct, m, t) {
  m = m || {};
  const e = estimativa(ct, m, t);
  const ultPedido = Math.max(num(m.pedidoEm), num(ct.pedidoWhatsEm));   /* inclui o pedido que o Hudson mandou pelo próprio WhatsApp */
  if (ultPedido && t - ultPedido < MIN_DIAS * DIA) return { pedir: false, motivo: 'pedido recente', e };
  if (e.dias != null && e.dias < MIN_DIAS) return { pedir: false, motivo: 'km recente', e };
  if (!e.km || !e.tBase) return { pedir: true, motivo: 'sem histórico de km', e };
  if (!e.kmDia && e.dias >= SEM_HIST_DIAS) return { pedir: true, motivo: 'sem km há ' + Math.round(e.dias) + ' dias', e };
  if (e.fo != null && e.fo <= MARGEM_OLEO) return { pedir: true, motivo: e.fo <= 0 ? 'óleo provavelmente vencido' : 'óleo perto da troca', e };
  if (e.fc != null && e.fc <= MARGEM_CORREIA) return { pedir: true, motivo: e.fc <= 0 ? 'correia provavelmente vencida' : 'correia perto da troca', e };
  return { pedir: false, motivo: 'em dia pela estimativa', e };
}

/* ---------------- ciclo (a cada 15 min, 8h–20h) ---------------- */
async function carregar(ctx) {
  const [contatos, estado, config, teste, status] = await Promise.all(['contatos', 'estado', 'config', 'teste', 'status'].map(c => ctx.get(c)));
  return { contatos: contatos || {}, estado: estado || {}, config: config || {}, teste, status: status || {} };
}
/* Prazo para o motorista responder (regra do Hudson: "não pode ficar um dia inteiro sem responder"):
   19h do mesmo dia do pedido; se o pedido saiu tarde, 3 horas depois dele. Mesma regra no Gestão. */
function prazoResposta(pedidoEm) {
  const d = agoraBRT(pedidoEm);
  const h19 = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 19 + 3);
  return Math.max(h19, pedidoEm + 3 * 3600e3);
}
function prontoParaEnviar(ct) { return !!(ct && ct.elegivel && ct.ativo && foneEnvio(ct.tel)); }

async function garantirModelo(ctx, status, st) {
  if (status.modelo === 'APPROVED' && status.modeloNome === MODELO.name) return true;
  if (!ctx.env.WABA_ID) return false;
  try {
    const lista = await ctx.wa(`${ctx.env.WABA_ID}/message_templates?name=${MODELO.name}&fields=name,status,language`);
    let t = (lista.data || []).find(x => x.name === MODELO.name && x.language === MODELO.language);
    if (!t) { await ctx.wa(`${ctx.env.WABA_ID}/message_templates`, MODELO); t = { status: 'PENDING' }; }
    st.modelo = t.status; st.modeloNome = MODELO.name;
    return t.status === 'APPROVED';
  } catch (e) { st.modelo = 'erro: ' + e.message.slice(0, 120); return false; }
}

async function ciclo(ctx, t = Date.now()) {
  const { contatos, estado, config, teste, status } = await carregar(ctx);
  const r = { enviados: [], atrasados: [], erros: [] };
  const st = {}; const upd = {};
  const modeloOk = await garantirModelo(ctx, status, st);
  const h = agoraBRT(t), hora = h.getUTCHours(), dow = h.getUTCDay();
  const janelaRotina = dow >= 1 && dow <= 6 && hora >= 9 && hora < 12;   /* pedidos de rotina: seg–sáb, 9h–12h */

  async function pedir(para, nome, carro, m) {
    const janela24h = m && m.ultimaMsgEm && t - m.ultimaMsgEm < 23 * 3600e3;   /* conversa aberta: mensagem livre e grátis */
    if (janela24h) await ctx.texto(para, textoPedidoLivre(nome, carro, t));
    else if (modeloOk) await ctx.modelo(para, [nome, saudacao(t), carro]);
    else throw new Error('modelo de mensagem ainda não aprovado pela Meta (' + (st.modelo || status.modelo || '?') + ')');
  }

  /* teste pedido pelo Gestão */
  if (teste && teste.tel && !teste.enviadoEm && !teste.erro && t - num(teste.em) < DIA) {
    const ct = contatos[teste.pk] || {};
    try {
      await pedir(foneEnvio(teste.tel), primeiroNome(ct.motorista) || 'teste', `${ct.carro || 'carro'} ${fmtPlaca(ct.placa || teste.pk)}`, null);
      upd['teste/enviadoEm'] = t; upd['estado/teste'] = { aberto: true, pedidoEm: t, pk: teste.pk, chave: foneChave(teste.tel) };
      r.enviados.push('teste');
    } catch (e) { upd['teste/erro'] = e.message.slice(0, 200); r.erros.push('teste: ' + e.message); }
  }

  const ligado = !!config.ativo;
  for (const pk of Object.keys(contatos).sort()) {
    if (ctx.sub >= 40) break;   /* limite do plano grátis por execução; o resto vai na próxima (15 min) */
    const ct = contatos[pk];
    if (!prontoParaEnviar(ct)) continue;
    const chave = foneChave(ct.tel);
    let m = estado[pk] || {};
    if (m.chave && m.chave !== chave) m = { pedirAtendido: m.pedirAtendido || null };   /* número trocado: recomeça do zero */
    const manual = num(ct.pedirAgora) > num(m.pedirAtendido);
    if (!ligado && !manual) continue;

    /* pedido aberto: sem foto até o fim do dia = atrasado (aparece em vermelho no Gestão).
       Depois de 7 dias sem resposta, se a troca ainda pedir, manda de novo. */
    if (!manual && m.aberto && t - num(m.pedidoEm) < MIN_DIAS * DIA) {
      if (t >= prazoResposta(num(m.pedidoEm))) {
        r.atrasados.push(pk);
        if (!m.atrasado) upd['estado/' + pk + '/atrasado'] = true;
      }
      continue;
    }
    let motivo = '';
    if (manual) motivo = 'manual';
    else if (janelaRotina) {
      const av = precisaPedir(ct, m, t);
      if (av.pedir) motivo = av.motivo;
    }
    if (!motivo) continue;
    const carro = `${ct.carro || 'carro'} ${fmtPlaca(ct.placa || pk)}`.trim();
    const atendido = manual ? num(ct.pedirAgora) : (num(m.pedirAtendido) || null);
    try {
      await pedir(foneEnvio(ct.tel), primeiroNome(ct.motorista), carro, m);
      upd['estado/' + pk] = { ...m, chave, aberto: true, pedidoEm: t, atrasado: false, falhas: 0, suspeito: null, lembrouAudio: false, motivo, pedirAtendido: atendido, erro: null };
      r.enviados.push(pk);
    } catch (e) {
      r.erros.push(`${pk}: ${e.message}`);
      upd['estado/' + pk + '/erro'] = e.message.slice(0, 200);
      if (manual) upd['estado/' + pk + '/pedirAtendido'] = num(ct.pedirAgora);   /* não fica tentando em loop */
    }
  }

  const mudou = r.enviados.length || r.erros.length || Object.keys(upd).length || Object.keys(st).some(k => st[k] !== status[k]);
  if (mudou || t - num(status.ultimaExecucao) > 3600e3) {
    upd['status'] = { ...status, ...st, versao: VERSAO, ultimaExecucao: t, ultimosEnviados: r.enviados.length, erros: r.erros.slice(0, 5) };
  }
  if (Object.keys(upd).length) await ctx.patch('', upd);
  return r;
}

/* ---------------- mensagens recebidas (webhook) ---------------- */
async function processarWebhook(ctx, corpo) {
  const msgs = [];
  for (const e of corpo.entry || []) for (const ch of e.changes || []) {
    if (ch.field !== 'messages') continue;   /* ignora ecos do app (smb_message_echoes), status etc. */
    const v = ch.value || {};
    if (ctx.env.PHONE_NUMBER_ID && v.metadata && v.metadata.phone_number_id && String(v.metadata.phone_number_id) !== String(ctx.env.PHONE_NUMBER_ID)) continue;
    for (const m of v.messages || []) msgs.push(m);
  }
  if (!msgs.length) return { ok: true, msgs: 0 };
  const [contatos, estado] = await Promise.all([ctx.get('contatos'), ctx.get('estado')]);
  const porChave = {};
  for (const pk of Object.keys(contatos || {})) { const ct = contatos[pk]; if (prontoParaEnviar(ct)) porChave[foneChave(ct.tel)] = { key: pk, pk }; }
  const et = (estado || {}).teste;
  if (et && et.chave && Date.now() - num(et.pedidoEm) < DIA) porChave[et.chave] = { key: 'teste', pk: et.pk };

  const out = [];
  for (const msg of msgs) {
    const alvo = porChave[foneChave(msg.from)];
    if (!alvo) { out.push('desconhecido'); continue; }   /* não é motorista ligado: o robô não mexe */
    const { key, pk } = alvo;
    const m = { ...((estado || {})[key] || {}) };
    const vistos = m.vistos || [];
    if (vistos.includes(msg.id)) { out.push('repetida'); continue; }
    m.vistos = [msg.id, ...vistos].slice(0, 15);
    m.ultimaMsgEm = Date.now();
    try {
      const ctx3 = (contatos || {})[pk] || {};
      /* pedido feito pelo Hudson no WhatsApp dele (botão do Gestão): a foto que chegar em até 3 dias também é lida */
      const pedidoManual = num(ctx3.pedidoWhatsEm) > num(m.leituraEm) && Date.now() - num(ctx3.pedidoWhatsEm) < 3 * DIA;
      if (msg.type === 'image' && msg.image && msg.image.id && (m.aberto || pedidoManual)) out.push(await tratarFoto(ctx, pk, (contatos || {})[pk] || {}, m, msg, key === 'teste'));
      else if (msg.type === 'audio' && (m.aberto || pedidoManual) && !m.lembrouAudio) {
        /* respondeu com áudio em vez da foto: lembra UMA vez por pedido, com educação */
        m.lembrouAudio = true;
        await ctx.texto(msg.from, MSG_AUDIO(primeiroNome(ctx3.motorista)));
        out.push('audio:lembrete');
      }
      else out.push('ignorada:' + msg.type);
    } catch (e) { out.push('erro:' + e.message); await ctx.log(`foto ${pk}: ${e.message}`); }
    await ctx.put('estado/' + key, m);
    if (estado) estado[key] = m;
  }
  return { ok: true, out };
}

async function tratarFoto(ctx, pk, ct, m, msg, teste) {
  const agora = Date.now(), para = msg.from;
  const midia = await ctx.baixarMidia(msg.image.id);
  const lido = await lerOdometro(ctx, midia);
  const reg = { em: agora, pk, km: lido.km, painel: lido.painel, certeza: lido.certeza, obs: lido.obs };
  const hist = 'historico/' + (teste ? 'teste' : pk);

  if (!lido.painel || !lido.km) {
    m.falhas = num(m.falhas) + 1;
    await ctx.post(hist, { ...reg, resultado: 'ilegivel' });
    if (m.falhas <= 2) await ctx.texto(para, MSG_ILEGIVEL);
    return 'ilegivel';
  }
  const km = lido.km;
  const av = avaliarLeitura(ct, m, km, agora);
  if (!av.ok) {
    if (!(m.suspeito && Math.abs(m.suspeito - km) <= 100)) {   /* 1ª vez: pede outra foto, pode ser erro de leitura */
      m.suspeito = km;
      await ctx.post(hist, { ...reg, resultado: 'conferir', tipo: av.tipo, ref: av.ref });
      await ctx.texto(para, msgConferir(km));
      return 'conferir';
    }
    /* 2ª foto confirma o mesmo número: NÃO entra no Gestão e vira alerta para o Hudson */
    m.suspeita = { km, ref: av.ref, refData: av.refData, tipo: av.tipo, em: agora, resolvida: false };
    Object.assign(m, { aberto: false, atrasado: false, suspeito: null, falhas: 0 });
    await ctx.post(hist, { ...reg, resultado: 'suspeita', tipo: av.tipo, ref: av.ref });
    await ctx.texto(para, MSG_SUSPEITA);
    return 'suspeita:' + av.tipo;
  }
  if (!teste) await ctx.put('leituras/' + pk, { km, data: dataBRT(agora), em: agora, certeza: lido.certeza });   /* o Gestão aplica no carro */
  await ctx.post(hist, { ...reg, resultado: 'ok' });
  Object.assign(m, { aberto: false, atrasado: false, leituraEm: agora, km, falhas: 0, suspeito: null, lembrouAudio: false });
  await ctx.texto(para, textoResposta(ct, km, primeiroNome(ct.motorista)));
  return 'ok:' + km;
}

/* ---------------- HTTP ---------------- */
async function http(req, env, exec) {
  const url = new URL(req.url);
  if (url.pathname === '/webhook') {
    if (req.method === 'GET') {
      const q = url.searchParams;
      if (q.get('hub.mode') === 'subscribe' && q.get('hub.verify_token') === (env.VERIFY_TOKEN || 'guimascar-robo-km')) return new Response(q.get('hub.challenge') || '', { status: 200 });
      return new Response('forbidden', { status: 403 });
    }
    if (req.method === 'POST') {
      const corpo = await req.json().catch(() => ({}));
      const ctx = new Ctx(env);
      exec.waitUntil(processarWebhook(ctx, corpo).catch(e => ctx.log('webhook: ' + e.message)));
      return new Response('ok', { status: 200 });
    }
  }
  if (url.pathname === '/') return new Response(VERSAO + ' · ok', { status: 200 });
  /* diagnóstico: /adm/<código>/ler?img=URL testa a leitura de uma foto de painel (código = sha256('adm:'+ROBO_ID), 32 primeiros) */
  const p = url.pathname.split('/').filter(Boolean);
  if (p[0] === 'adm' && p.length >= 3) {
    const ctx = new Ctx(env);
    const cod = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('adm:' + env.ROBO_ID.trim())))].map(x => x.toString(16).padStart(2, '0')).join('').slice(0, 32);
    if (p[1] !== cod) return new Response('not found', { status: 404 });
    const J = o => new Response(JSON.stringify(o, null, 2), { headers: { 'content-type': 'application/json; charset=utf-8' } });
    if (p[2] === 'ler') {
      const r = await fetch(url.searchParams.get('img'), { headers: { 'user-agent': 'GuimasCarRoboKm/2.1 (teste de leitura)' } });
      const midia = { bytes: await r.arrayBuffer(), mime: r.headers.get('content-type') || 'image/jpeg' };
      const info = { http: r.status, tipo: midia.mime, bytes: midia.bytes.byteLength };
      try { return J({ leitura: await lerOdometro(ctx, midia), ...info }); } catch (e) { return J({ erro: e.message, ...info }); }
    }
    if (p[2] === 'contatos') { const [c, e] = await Promise.all([ctx.get('contatos'), ctx.get('estado')]); const so = (url.searchParams.get('pk') || '').split(',').filter(Boolean);
      const f = o => so.length ? Object.fromEntries(Object.entries(o || {}).filter(([k]) => so.includes(k))) : o; return J({ contatos: f(c), estado: f(e) }); }
    if (p[2] === 'simular') {   /* lê uma foto real e mostra a resposta que o motorista receberia; &aplicar=1 grava a leitura */
      const pk = url.searchParams.get('pk'), r = await fetch(url.searchParams.get('img'), { headers: { 'user-agent': 'GuimasCarRoboKm' } });
      const midia = { bytes: await r.arrayBuffer(), mime: r.headers.get('content-type') || 'image/jpeg' };
      const ct = (await ctx.get('contatos/' + pk)) || {}, m = (await ctx.get('estado/' + pk)) || {}, agora = Date.now();
      const lido = await lerOdometro(ctx, midia);
      if (!lido.painel || !lido.km) return J({ lido, resposta: MSG_ILEGIVEL });
      const av = avaliarLeitura(ct, m, lido.km, agora);
      if (!av.ok) return J({ lido, avaliacao: av, resposta: msgConferir(lido.km) + '  (se a 2ª foto confirmar: ' + MSG_SUSPEITA + ')' });
      const resposta = textoResposta(ct, lido.km, primeiroNome(ct.motorista));
      if (url.searchParams.get('aplicar') === '1') {
        await ctx.put('leituras/' + pk, { km: lido.km, data: dataBRT(agora), em: agora, certeza: lido.certeza, origem: 'simulação' });
        await ctx.patch('estado/' + pk, { aberto: false, atrasado: false, leituraEm: agora, km: lido.km, falhas: 0, suspeito: null });
        await ctx.post('historico/' + pk, { em: agora, pk, km: lido.km, painel: true, certeza: lido.certeza, resultado: 'ok', origem: 'simulação' });
      }
      return J({ lido, avaliacao: av, contato: { kmUltima: ct.kmUltima, kmUltimaData: ct.kmUltimaData, proxOleoKm: ct.proxOleoKm, temCorreia: ct.temCorreia, proxCorreiaKm: ct.proxCorreiaKm, kmDia: ct.kmDia }, resposta, aplicado: url.searchParams.get('aplicar') === '1' });
    }
    if (p[2] === 'status') return J({ versao: VERSAO, status: await ctx.get('status'), config: await ctx.get('config'), temWA: !!env.WA_KEY, phone: env.PHONE_NUMBER_ID || '', waba: env.WABA_ID || '' });
  }
  return new Response('not found', { status: 404 });
}

export default {
  async fetch(req, env, exec) {
    try { return await http(req, env, exec); }
    catch (e) { return new Response('erro', { status: 500 }); }
  },
  async scheduled(evt, env, exec) {
    exec.waitUntil((async () => {
      let ctx; try { ctx = new Ctx(env); await ciclo(ctx, evt.scheduledTime || Date.now()); }
      catch (e) { if (ctx) await ctx.log('cron: ' + e.message); }
    })());
  }
};

/* exportado só para os testes locais */
export const _t = { avaliarLeitura, lerOdometro, precisaPedir, estimativa, foneChave, foneEnvio, interpretarResposta, plausivel, textoResposta, ciclo, processarWebhook, Ctx, primeiroNome, fmtPlaca, saudacao, MODELO, textoPedidoLivre, marcaCarro, linhaOleo, prazoResposta };
