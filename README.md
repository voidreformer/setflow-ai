# 📅 SetFlow AI — Autonomous Appointment Setter & Qualification Engine

[![Live App](https://img.shields.io/badge/🌐_Live_App-setflow--ai.vercel.app-000000?style=for-the-badge&logo=vercel)](https://setflow-ai.vercel.app)
![Build Status](https://img.shields.io/badge/Build-Passing-brightgreen?style=for-the-badge)
![AI Engine](https://img.shields.io/badge/AI%20Engine-NVIDIA%20Nemotron%203%20Ultra%20550B-76B900?style=for-the-badge&logo=nvidia)
![Database](https://img.shields.io/badge/Database-SQLite%20WASM%20(sql.js)-003B57?style=for-the-badge&logo=sqlite)
![License](https://img.shields.io/badge/License-MIT-blue?style=for-the-badge)

> 🚀 **Official Production Web App:** **[https://setflow-ai.vercel.app](https://setflow-ai.vercel.app)**
>
> **SetFlow AI** is a production-grade, autonomous sales appointment setter that qualifies leads, extracts budget & timeline requirements, and schedules calendar meetings in real-time.

---

## 🌟 Key Features

- **💬 Real-Time Multi-Turn Conversational AI:** Conversational lead intake powered by NVIDIA Nemotron 3 Ultra 550B.
- **🎯 Autonomous Lead Qualification:** Analyzes lead responses to calculate BANT qualification scores (Budget, Authority, Need, Timing).
- **📅 Dynamic Slot Scheduling:** Real-time calendar availability check & instant appointment booking.
- **🛡️ WASM SQLite Persistence & JWT Auth:** Embedded database (`appointment_setter.db`) storing leads, booked slots, and conversation transcripts.
- **📑 Appointment Export:** 1-click CSV Export for CRM integration.

---

## 🏬 Architecture & Stack

- **Core:** Express.js REST API + WASM SQLite (`sql.js`)
- **AI Engine:** NVIDIA Nemotron 3 Ultra 550B via OmniRoute Gateway
- **Frontend:** Slate Dark Neumorphic Design System

---

## 📄 License
Distributed under the MIT License. Built with ❤️ for real-world problem solving.
