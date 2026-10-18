---
name: Feature request
about: A capability Sentinel does not have yet
title: "feat: "
labels: enhancement
---

## Problem

<!-- Who hits this, and what they cannot do today. -->

## Proposed behavior

<!-- What the operator should see or what the API should return. Leave the implementation open if you do not have a preference. -->

## Constraints

Sentinel stays local-first. A new behavior should keep these properties:

- Reported evidence is not described as ground-truth accuracy.
- An operational failure does not become a passing security decision.
- Credentials stay in the OS vault (local mode) or the encrypted server vault (Docker). They are not written into a scan manifest.
- Unsupported engine, route, or model combinations are refused. Sentinel does not silently fall back to another route.

## Out of scope

<!-- Anything this request should not change. -->
