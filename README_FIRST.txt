Golden Classroom Web v0.1

目前完成：
- Supabase 帳密登入
- teacher / student 角色讀取
- 自動進入 Room1
- 顯示 Room 狀態
- 老師專屬「控制模式」選單
- 老師控制 / 學生控制 / 雙人控制
- 模式切換中央提示
- Supabase Realtime 同步骨架

上線前還需兩個設定：
1. 在 Supabase SQL Editor 執行 supabase_realtime.sql
2. 在 config.js 填入 Supabase Project URL 與 anon/publishable key
