# RequestTriageAI – Backend

This repository contains the **backend service** for **RequestTriageAI**, an AI-powered request and ticket triage system designed as a lightweight alternative to traditional tools like ServiceNow.

The backend handles ticket creation, AI-based triaging, SLA management, role-based access, analytics, and audit logging.

---

## Overview

The backend is built using **Node.js and Express**, with **Supabase** as the database and **Gemini AI** for intelligent request triaging.

It exposes a REST API consumed by the frontend dashboard and is designed to be:
- Simple
- Scalable
- Secure
- MVP-focused

---

## Core Responsibilities

- User creation and role management
- Ticket lifecycle management
- AI-based request triage
- SLA calculation and breach detection
- Comments and activity tracking
- Analytics and dashboard data
- Admin-level role assignment

---

## Tech Stack

- **Runtime:** Node.js
- **Framework:** Express.js
- **Database:** Supabase (PostgreSQL)
- **AI:** Google Gemini API
- **Hosting:** Render
- **Auth (MVP):** Email-based identification (no full auth yet)
- **Scheduler:** In-process interval jobs (SLA breach checker)

---

## Key Features

### 1. Ticket Management
- Create tickets with minimal input
- Update ticket status, priority, and assigned team
- Enforced lifecycle transitions (NEW → IN_PROGRESS → RESOLVED → CLOSED)
- Role-based restrictions on updates

---

### 2. AI-Powered Triage
Each ticket is automatically analyzed using Gemini AI to determine:
- Assigned team
- Priority (HIGH / MEDIUM / LOW)
- Problem summary
- Business impact
- Requested action
- Optional knowledge base suggestions

AI output is strictly validated as JSON before being stored.

---

### 3. SLA Handling
- SLA deadlines calculated using **business days**
- Priority-based SLA rules:
  - HIGH → 1 business day
  - MEDIUM → 3 business days
  - LOW → 5 business days
- Automatic SLA breach detection
- Background job runs every 5 minutes

---

### 4. Roles & Access Control

Supported roles:
- **REQUESTER** (default)
- **AGENT**
- **ADMIN**

Role capabilities:
- Requesters can create tickets, add comments, and change status (within limits)
- Agents can update priority and assignment
- Admins can manage users and roles

All permissions are enforced server-side.

---

### 5. Admin APIs
Admin-only endpoints allow:
- Searching users
- Updating roles (REQUESTER / AGENT / ADMIN)
- Updating user metadata (name, department)

Access is secured via an **admin key** passed in request headers.

---

### 6. Comments & Activity Logging
- Every ticket supports threaded comments
- All major actions are logged:
  - Ticket creation
  - Status changes
  - Priority changes
  - Team reassignment
  - SLA updates
- Activity feeds can be merged and displayed in the UI

---

### 7. Analytics & Reporting
Provides aggregated insights:
- Tickets by status
- Tickets by priority
- SLA compliance
- Tickets per team
- Open vs closed metrics

Designed for dashboard consumption.

---

