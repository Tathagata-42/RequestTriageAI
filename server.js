require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const { GoogleGenAI } = require("@google/genai");

const app = express();
// app.use(cors());


  const allowedOrigins = [
    "http://localhost:5173",
    process.env.FRONTEND_URL,
  ].filter(Boolean);
  
  app.use(
    cors({
      origin: (origin, cb) => {
        // allow requests with no origin (Postman/curl)
        if (!origin) return cb(null, true);
        if (allowedOrigins.includes(origin)) return cb(null, true);
        return cb(new Error(`CORS blocked for origin: ${origin}`));
      },
      credentials: true,
    })
  );
app.use(express.json());

// -------------------- Clients --------------------
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// NEW Gemini SDK client
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

// -------------------- Helpers --------------------
function addBusinessDays(dateIso, days) {
  const d = new Date(dateIso);
  let added = 0;
  while (added < days) {
    d.setDate(d.getDate() + 1);
    const day = d.getDay(); // 0 Sun, 6 Sat
    if (day !== 0 && day !== 6) added++;
  }
  return d.toISOString();
}

function slaDaysForPriority(priority) {
  if (priority === "HIGH") return 1;
  if (priority === "MEDIUM") return 3;
  return 5; // LOW
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    const cleaned = String(text || "")
      .replace(/```json/gi, "")
      .replace(/```/g, "")
      .trim();
    return JSON.parse(cleaned);
  }
}

async function triageWithGemini(payload) {
  const prompt = `
Return ONLY valid JSON. No markdown. No explanation.

You are an AI request triage assistant for an internal company tool (ServiceNow alternative).

Task:
Given the request details, produce:
- assignedTeam (FREE TEXT, one owning team)
- priority (HIGH|MEDIUM|LOW)
- summary { problem, impact, requestedAction }
- knowledgeSuggestions: array of 0-2 items { title, reason }

Teams available (you may choose one or a close variant as free text):
IT Support, HR / People Ops, Engineering, Operations, Finance, Facilities,
Security / Compliance, Procurement, Legal, Other / General.

Priority rules:
- HIGH if work is blocked OR timeline is ASAP OR major business impact.
- MEDIUM for normal operational issues.
- LOW for informational / non-urgent requests.

Request JSON:
${JSON.stringify(payload)}

Output JSON schema:
{
  "assignedTeam": "string",
  "priority": "HIGH|MEDIUM|LOW",
  "summary": {
    "problem": "string",
    "impact": "string",
    "requestedAction": "string"
  },
  "knowledgeSuggestions": [
    { "title": "string", "reason": "string" }
  ]
}
`.trim();

  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: prompt,
  });

  return safeJsonParse(response.text);
}

// Lifecycle transitions (LOCKED)
const ALLOWED = {
  NEW: ["IN_PROGRESS"],
  IN_PROGRESS: ["WAITING", "RESOLVED"],
  WAITING: ["IN_PROGRESS"],
  RESOLVED: ["CLOSED"],
  CLOSED: [],
};

const VALID_ROLES = ["REQUESTER", "AGENT", "ADMIN"];

// Admin guard (header-based)
function requireAdmin(req, res, next) {
  const key = req.header("x-admin-key") || "";
  if (!process.env.ADMIN_KEY) {
    return res.status(500).json({ error: "ADMIN_KEY not configured in server env" });
  }
  if (!key || key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: "Unauthorized (missing/invalid x-admin-key)" });
  }
  next();
}

// Friendly activity formatting
function formatAuditMessage(a) {
  if (a.action === "TICKET_CREATED") return "Ticket created";
  if (a.action === "STATUS_CHANGED") return `Status changed: ${a.old_value} → ${a.new_value}`;
  if (a.action === "TEAM_CHANGED") return `Team changed: ${a.old_value} → ${a.new_value}`;
  if (a.action === "PRIORITY_CHANGED") return `Priority changed: ${a.old_value} → ${a.new_value}`;
  if (a.action === "SLA_UPDATED") return `SLA updated: ${a.old_value} → ${a.new_value}`;
  if (a.action === "COMMENT_ADDED") return "Comment added";
  if (a.field_name) return `${a.action}: ${a.field_name}`;
  return a.action || "Activity";
}

// -------------------- Routes --------------------

// Health check
app.get("/health", (_, res) => res.json({ ok: true }));

/**
 * ✅ NEW: GET /api/me?email=...
 * Returns user role. If user doesn't exist, treat as REQUESTER.
 */
app.get("/api/me", async (req, res) => {
  try {
    const email = String(req.query.email || "").trim();
    if (!email) return res.status(400).json({ error: "email is required" });

    const { data: user, error } = await supabase
      .from("users")
      .select("id,email,name,department,role")
      .eq("email", email)
      .maybeSingle();

    if (error) throw error;

    if (!user?.id) {
      return res.json({
        user: {
          id: null,
          email,
          name: null,
          department: null,
          role: "REQUESTER",
        },
      });
    }

    return res.json({ user });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Server error" });
  }
});

/**
 * ✅ NEW (ADMIN): GET /api/admin/users?query=...
 * Header: x-admin-key
 */
app.get("/api/admin/users", requireAdmin, async (req, res) => {
  try {
    const query = String(req.query.query || "").trim();

    let q = supabase
      .from("users")
      .select("id,email,name,department,role,created_at")
      .order("created_at", { ascending: false })
      .limit(50);

    if (query) {
      // matches email OR name
      q = q.or(`email.ilike.%${query}%,name.ilike.%${query}%`);
    }

    const { data: users, error } = await q;
    if (error) throw error;

    return res.json({ users: users || [] });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Server error" });
  }
});

/**
 * ✅ NEW (ADMIN): PATCH /api/admin/users/role
 * Header: x-admin-key
 * Body: { email, role, name?, department? }
 */
app.patch("/api/admin/users/role", requireAdmin, async (req, res) => {
  try {
    const { email, role, name, department } = req.body || {};
    const em = String(email || "").trim();
    const rl = String(role || "").trim().toUpperCase();

    if (!em) return res.status(400).json({ error: "email is required" });
    if (!VALID_ROLES.includes(rl)) {
      return res.status(400).json({ error: "role must be REQUESTER|AGENT|ADMIN" });
    }

    const { data: existing, error: findErr } = await supabase
      .from("users")
      .select("id")
      .eq("email", em)
      .maybeSingle();
    if (findErr) throw findErr;

    let updatedUser = null;

    if (!existing?.id) {
      // create user with explicit role
      const { data: created, error: createErr } = await supabase
        .from("users")
        .insert({
          email: em,
          name: name || null,
          department: department || null,
          role: rl,
        })
        .select("id,email,name,department,role,created_at")
        .single();
      if (createErr) throw createErr;
      updatedUser = created;
    } else {
      const { data: updated, error: updErr } = await supabase
        .from("users")
        .update({
          role: rl,
          name: name !== undefined ? (name || null) : undefined,
          department: department !== undefined ? (department || null) : undefined,
        })
        .eq("id", existing.id)
        .select("id,email,name,department,role,created_at")
        .single();
      if (updErr) throw updErr;
      updatedUser = updated;
    }

    return res.json({ ok: true, user: updatedUser });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Server error" });
  }
});

/**
 * POST /api/tickets
 */
app.post("/api/tickets", async (req, res) => {
  try {
    const {
      email,
      name,
      department,
      title,
      description,
      affectedSystem,
      isBlocking,
      requestedTimeline, // ASAP | TODAY | THIS_WEEK | NO_RUSH
      tryKbFirst,
    } = req.body || {};

    if (!email || !title || !description) {
      return res
        .status(400)
        .json({ error: "email, title, description are required" });
    }

    // 1) Find or create user (default role REQUESTER)
    const { data: existingUser, error: findErr } = await supabase
      .from("users")
      .select("id")
      .eq("email", email)
      .maybeSingle();

    if (findErr) throw findErr;

    let userId = existingUser?.id;

    if (!userId) {
      const { data: created, error: createErr } = await supabase
        .from("users")
        .insert({
          email,
          name: name || null,
          department: department || null,
          role: "REQUESTER",
        })
        .select("id")
        .single();

      if (createErr) throw createErr;
      userId = created.id;
    } else {
      if (name || department) {
        await supabase
          .from("users")
          .update({
            name: name || null,
            department: department || null,
          })
          .eq("id", userId);
      }
    }

    // 2) Gemini triage (one call)
    let triage;
    try {
      triage = await triageWithGemini({
        email,
        name,
        department,
        title,
        description,
        affectedSystem,
        isBlocking: !!isBlocking,
        requestedTimeline: requestedTimeline || null,
      });
      console.log("✅ Gemini triage OK:", triage);
    } catch (aiErr) {
      console.error("❌ Gemini triage FAILED:", aiErr?.message || aiErr);
      console.error("❌ Gemini triage FULL:", aiErr);
      triage = null; // fallback
    }

    const assignedTeam = triage?.assignedTeam
      ? String(triage.assignedTeam)
      : "Other / General";

    const priority = ["HIGH", "MEDIUM", "LOW"].includes(triage?.priority)
      ? triage.priority
      : "MEDIUM";

    const aiProblem = triage?.summary?.problem || null;
    const aiImpact = triage?.summary?.impact || null;
    const aiAction = triage?.summary?.requestedAction || null;

    const knowledgeSuggestions = Array.isArray(triage?.knowledgeSuggestions)
      ? triage.knowledgeSuggestions.slice(0, 2)
      : [];

    // 3) SLA
    const nowIso = new Date().toISOString();
    const slaDueAt = addBusinessDays(nowIso, slaDaysForPriority(priority));

    // 4) Create ticket
    const { data: ticket, error: ticketErr } = await supabase
      .from("tickets")
      .insert({
        requester_user_id: userId,

        title,
        description,
        affected_system: affectedSystem || null,
        is_blocking: !!isBlocking,
        requested_timeline: requestedTimeline || null,
        try_kb_first: tryKbFirst !== false, // default true

        assigned_team: assignedTeam,
        priority,

        ai_summary_problem: aiProblem,
        ai_summary_impact: aiImpact,
        ai_summary_action: aiAction,
        ai_knowledge_suggestions: knowledgeSuggestions,

        status: "NEW",
        sla_due_at: slaDueAt,
        sla_status: "ON_TRACK",
        updated_at: nowIso,
      })
      .select(
        "id, status, assigned_team, priority, sla_due_at, sla_status, created_at"
      )
      .single();

    if (ticketErr) throw ticketErr;

    // 5) Audit log
    await supabase.from("audit_logs").insert({
      ticket_id: ticket.id,
      actor_id: userId,
      action: "TICKET_CREATED",
      field_name: null,
      old_value: null,
      new_value: null,
    });

    return res.status(201).json({
      id: ticket.id,
      status: ticket.status,
      assignedTeam: ticket.assigned_team,
      priority: ticket.priority,
      slaDueAt: ticket.sla_due_at,
      slaStatus: ticket.sla_status,
      createdAt: ticket.created_at,
      knowledgeSuggestions,
    });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Server error" });
  }
});

/**
 * GET /api/tickets?scope=my|team|all&email=...&team=...
 */
app.get("/api/tickets", async (req, res) => {
  try {
    const scope = String(req.query.scope || "");
    const email = String(req.query.email || "");
    const team = String(req.query.team || "");

    if (!scope)
      return res.status(400).json({ error: "scope is required: my|team|all" });

    if (scope === "my") {
      if (!email)
        return res.status(400).json({ error: "email is required for scope=my" });

      const { data: user, error: uErr } = await supabase
        .from("users")
        .select("id")
        .eq("email", email)
        .maybeSingle();
      if (uErr) throw uErr;
      if (!user?.id) return res.json({ tickets: [] });

      const { data: tickets, error: tErr } = await supabase
        .from("tickets")
        .select(
          "id,title,assigned_team,priority,status,sla_due_at,sla_status,created_at,updated_at,ai_summary_problem,ai_summary_impact,ai_summary_action,ai_knowledge_suggestions"
        )
        .eq("requester_user_id", user.id)
        .order("created_at", { ascending: false });

      if (tErr) throw tErr;
      return res.json({ tickets: tickets || [] });
    }

    if (scope === "team") {
      if (!team)
        return res.status(400).json({ error: "team is required for scope=team" });

      const { data: tickets, error: tErr } = await supabase
        .from("tickets")
        .select(
          "id,title,assigned_team,priority,status,sla_due_at,sla_status,created_at,updated_at,ai_summary_problem,ai_summary_impact,ai_summary_action,ai_knowledge_suggestions"
        )
        .eq("assigned_team", team)
        .order("created_at", { ascending: false });

      if (tErr) throw tErr;
      return res.json({ tickets: tickets || [] });
    }

    if (scope === "all") {
      const { data: tickets, error: tErr } = await supabase
        .from("tickets")
        .select(
          "id,title,assigned_team,priority,status,sla_due_at,sla_status,created_at,updated_at,ai_summary_problem,ai_summary_impact,ai_summary_action,ai_knowledge_suggestions"
        )
        .order("created_at", { ascending: false });

      if (tErr) throw tErr;
      return res.json({ tickets: tickets || [] });
    }

    return res.status(400).json({ error: "invalid scope. use my|team|all" });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Server error" });
  }
});

/**
 * PATCH /api/tickets/:id
 * Body: actorEmail + optional status/priority/assignedTeam/comment
 */
app.patch("/api/tickets/:id", async (req, res) => {
  try {
    const ticketId = req.params.id;
    const { actorEmail, status, priority, assignedTeam, comment } = req.body || {};

    if (!actorEmail)
      return res.status(400).json({ error: "actorEmail is required" });

    const { data: actor, error: aErr } = await supabase
      .from("users")
      .select("id, role, email")
      .eq("email", actorEmail)
      .maybeSingle();
    if (aErr) throw aErr;
    if (!actor?.id) return res.status(400).json({ error: "actor not found" });

    const { data: current, error: cErr } = await supabase
      .from("tickets")
      .select("*")
      .eq("id", ticketId)
      .single();
    if (cErr) throw cErr;

    const updates = {};
    const audits = [];
    const nowIso = new Date().toISOString();

    if (status && status !== current.status) {
      const allowed = ALLOWED[current.status] || [];
      if (!allowed.includes(status)) {
        return res.status(400).json({
          error: `Invalid status transition: ${current.status} -> ${status}`,
        });
      }
      updates.status = status;
      audits.push({
        ticket_id: ticketId,
        actor_id: actor.id,
        action: "STATUS_CHANGED",
        field_name: "status",
        old_value: current.status,
        new_value: status,
      });
    }

    if (assignedTeam && assignedTeam !== current.assigned_team) {
      if (actor.role === "REQUESTER") {
        return res.status(403).json({ error: "Requester cannot reassign team" });
      }
      updates.assigned_team = assignedTeam;
      audits.push({
        ticket_id: ticketId,
        actor_id: actor.id,
        action: "TEAM_CHANGED",
        field_name: "assigned_team",
        old_value: current.assigned_team,
        new_value: assignedTeam,
      });
    }

    if (priority && priority !== current.priority) {
      if (actor.role === "REQUESTER") {
        return res.status(403).json({ error: "Requester cannot change priority" });
      }
      if (!["HIGH", "MEDIUM", "LOW"].includes(priority)) {
        return res.status(400).json({ error: "priority must be HIGH|MEDIUM|LOW" });
      }

      const newDue = addBusinessDays(nowIso, slaDaysForPriority(priority));
      updates.priority = priority;
      updates.sla_due_at = newDue;
      updates.sla_status = "ON_TRACK";

      audits.push({
        ticket_id: ticketId,
        actor_id: actor.id,
        action: "PRIORITY_CHANGED",
        field_name: "priority",
        old_value: current.priority,
        new_value: priority,
      });
      audits.push({
        ticket_id: ticketId,
        actor_id: actor.id,
        action: "SLA_UPDATED",
        field_name: "sla_due_at",
        old_value: current.sla_due_at,
        new_value: newDue,
      });
    }

    if (comment && String(comment).trim()) {
      await supabase.from("ticket_comments").insert({
        ticket_id: ticketId,
        author_id: actor.id,
        body: String(comment).trim(),
      });

      audits.push({
        ticket_id: ticketId,
        actor_id: actor.id,
        action: "COMMENT_ADDED",
        field_name: null,
        old_value: null,
        new_value: null,
      });
    }

    if (!Object.keys(updates).length && !audits.length) {
      return res.json({ ok: true, message: "No changes" });
    }

    updates.updated_at = nowIso;

    if (Object.keys(updates).length) {
      const { error: uErr } = await supabase
        .from("tickets")
        .update(updates)
        .eq("id", ticketId);
      if (uErr) throw uErr;
    }

    if (audits.length) {
      const { error: logErr } = await supabase.from("audit_logs").insert(audits);
      if (logErr) throw logErr;
    }

    const { data: updated, error: rErr } = await supabase
      .from("tickets")
      .select(
        "id,title,assigned_team,priority,status,sla_due_at,sla_status,created_at,updated_at,ai_summary_problem,ai_summary_impact,ai_summary_action,ai_knowledge_suggestions"
      )
      .eq("id", ticketId)
      .single();
    if (rErr) throw rErr;

    return res.json({ ok: true, ticket: updated });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Server error" });
  }
});

/**
 * GET /api/analytics?scope=my|team|all&email=...&team=...
 */
app.get("/api/analytics", async (req, res) => {
  try {
    const scope = String(req.query.scope || "");
    const email = String(req.query.email || "");
    const team = String(req.query.team || "");

    let q = supabase
      .from("tickets")
      .select("status, priority, sla_status, assigned_team, requester_user_id");

    if (scope === "my") {
      if (!email) return res.status(400).json({ error: "email required for scope=my" });

      const { data: user, error: uErr } = await supabase
        .from("users")
        .select("id")
        .eq("email", email)
        .maybeSingle();
      if (uErr) throw uErr;
      if (!user?.id) return res.json({ kpis: {}, charts: {} });

      q = q.eq("requester_user_id", user.id);
    } else if (scope === "team") {
      if (!team) return res.status(400).json({ error: "team required for scope=team" });
      q = q.eq("assigned_team", team);
    } else if (scope === "all") {
      // no filter
    } else {
      return res.status(400).json({ error: "scope must be my|team|all" });
    }

    const { data: rows, error } = await q;
    if (error) throw error;

    const statusCounts = {};
    const priorityCounts = {};
    const slaCounts = {};
    const teamCounts = {};

    for (const r of rows || []) {
      statusCounts[r.status] = (statusCounts[r.status] || 0) + 1;
      priorityCounts[r.priority] = (priorityCounts[r.priority] || 0) + 1;
      slaCounts[r.sla_status] = (slaCounts[r.sla_status] || 0) + 1;
      teamCounts[r.assigned_team] = (teamCounts[r.assigned_team] || 0) + 1;
    }

    const total = (rows || []).length;
    const open = total - (statusCounts["CLOSED"] || 0);
    const breached = slaCounts["BREACHED"] || 0;

    return res.json({
      kpis: { total, open, breached },
      charts: {
        byStatus: statusCounts,
        byPriority: priorityCounts,
        bySla: slaCounts,
        byTeam: teamCounts,
      },
    });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Server error" });
  }
});

async function checkAndBreachSLAs() {
  try {
    const nowIso = new Date().toISOString();

    const { data: overdueTickets, error } = await supabase
      .from("tickets")
      .select("id, sla_due_at, sla_status")
      .lt("sla_due_at", nowIso)
      .neq("sla_status", "BREACHED");

    if (error) throw error;

    if (!overdueTickets || overdueTickets.length === 0) {
      console.log("🟢 SLA check: no breaches");
      return;
    }

    const ids = overdueTickets.map((t) => t.id);

    await supabase
      .from("tickets")
      .update({ sla_status: "BREACHED" })
      .in("id", ids);

    console.log(`🔴 SLA breached for ${ids.length} ticket(s)`);
  } catch (e) {
    console.error("❌ SLA check failed:", e.message);
  }
}

// GET comments for a ticket
app.get("/api/tickets/:id/comments", async (req, res) => {
  try {
    const ticketId = req.params.id;

    const { data: rows, error } = await supabase
      .from("ticket_comments")
      .select("id, body, created_at, author_id")
      .eq("ticket_id", ticketId)
      .order("created_at", { ascending: false });

    if (error) throw error;

    let authorMap = {};
    const authorIds = Array.from(
      new Set((rows || []).map((r) => r.author_id).filter(Boolean))
    );

    if (authorIds.length) {
      const { data: users, error: uErr } = await supabase
        .from("users")
        .select("id, name, email")
        .in("id", authorIds);

      if (uErr) throw uErr;

      for (const u of users || []) authorMap[u.id] = u;
    }

    const comments = (rows || []).map((c) => ({
      id: c.id,
      body: c.body,
      createdAt: c.created_at,
      author: authorMap[c.author_id] || { id: c.author_id, name: null, email: null },
    }));

    return res.json({ comments });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Server error" });
  }
});

/**
 * GET /api/tickets/:id/activity
 * Returns merged timeline of audit logs + comments
 */
app.get("/api/tickets/:id/activity", async (req, res) => {
  try {
    const ticketId = req.params.id;

    // 1) Audit logs
    const { data: audits, error: aErr } = await supabase
      .from("audit_logs")
      .select("id, action, field_name, old_value, new_value, created_at, actor_id")
      .eq("ticket_id", ticketId)
      .order("created_at", { ascending: false });

    if (aErr) throw aErr;

    // 2) Comments
    const { data: comments, error: cErr } = await supabase
      .from("ticket_comments")
      .select("id, body, created_at, author_id")
      .eq("ticket_id", ticketId)
      .order("created_at", { ascending: false });

    if (cErr) throw cErr;

    // 3) user ids
    const userIdsSet = new Set();
    for (const a of audits || []) if (a.actor_id) userIdsSet.add(a.actor_id);
    for (const c of comments || []) if (c.author_id) userIdsSet.add(c.author_id);

    const userIds = Array.from(userIdsSet);

    let usersById = {};
    if (userIds.length) {
      const { data: users, error: uErr } = await supabase
        .from("users")
        .select("id, name, email, role")
        .in("id", userIds);

      if (uErr) throw uErr;

      for (const u of users || []) {
        usersById[u.id] = { id: u.id, name: u.name, email: u.email, role: u.role };
      }
    }

    // 4) Normalize
    const auditEvents = (audits || []).map((a) => ({
      id: a.id,
      type: "AUDIT",
      createdAt: a.created_at,
      actor: usersById[a.actor_id] || null,
      action: a.action,
      field: a.field_name,
      oldValue: a.old_value,
      newValue: a.new_value,
      message: formatAuditMessage(a),
    }));

    const commentEvents = (comments || []).map((c) => ({
      id: c.id,
      type: "COMMENT",
      createdAt: c.created_at,
      actor: usersById[c.author_id] || null,
      body: c.body,
      message: "Comment added",
    }));

    const timeline = [...auditEvents, ...commentEvents].sort(
      (x, y) => new Date(y.createdAt) - new Date(x.createdAt)
    );

    return res.json({ ticketId, timeline });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Server error" });
  }
});

// Run SLA check every 5 minutes
setInterval(checkAndBreachSLAs, 5 * 60 * 1000);
// Run once on startup
checkAndBreachSLAs();

// -------------------- Start Server --------------------
app.listen(process.env.PORT || 3001, () => {
  console.log("API running on port", process.env.PORT || 3001);
});