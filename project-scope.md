# AI-powered ticket management system

## Problem

We receive hundreds of support emails daily. Our agents manually read, classify and respond to each ticket - which is slow and leads to impersonal, canned responses.

## Solution

Build a ticket management system that uses AI to automatically classify, respond to, and route support tickets - delivering faster, more personalised responses to students while freeing up agents for complex issues.

## Features

- Receive support emails and create tickets.
- Auto-generate human-friendly responses using a knowledge base.
- Ticket list with filtering and sorting
- Ticket detail view
- AI-powered ticket classification
- AI summaries
- AI-suggested replies
- User management (admin only)
- Dashboard to view and manage all tickets

## Ticket statuses

A ticket is always in exactly one of three statuses:

- **Open** - the ticket has been received and is being worked on.
- **Resolved** - a response has been sent and the issue is believed to be answered.
- **Closed** - the ticket is finished and requires no further action.

## Ticket categories

Every ticket belongs to a single category, assigned by the AI classifier and editable by an agent:

- **General Question**
- **Technical Question**
- **Refund Request**

## Users and roles

The system is deployed with a single **Admin** account already in place. There is no self-registration.

- **Admin** - full access to the system, plus user management. Creates, edits and deactivates agent accounts.
- **Agent** - works tickets: views the dashboard and ticket list, reads ticket detail, changes status and category, and sends replies. Cannot manage users.
