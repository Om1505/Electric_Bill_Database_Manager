const express = require('express');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.static('public'));

const pool = new Pool({
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    host: process.env.DB_HOST,
    database: process.env.DB_DATABASE,
    port: process.env.DB_PORT,
});

pool.on('connect', (client) => {
    client.query('SET search_path TO Electricity_Grid;');
});

// ==========================================
// 1. CONSUMER DASHBOARD
// ==========================================
app.get('/api/consumer/:id/bills', async (req, res) => {
    try {
        const queryText = `
            SELECT c.Cons_Name, c.Email, il.Inv_No, il.Bill_Amt, il.Inv_Date, 
                   id.Units_Consumed, id.Solar_Units_Gen, COALESCE(p.Payment_Method, 'UNPAID') as Status
            FROM Consumer c 
            JOIN Invoice_List il ON c.User_ID = il.UserID
            JOIN Invoice_Details id ON il.Inv_No = id.Inv_No
            LEFT JOIN Payments p ON il.Payment_ID = p.Payment_ID
            WHERE c.User_ID = $1;
        `;
        const result = await pool.query(queryText, [req.params.id]);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/consumer/:id/complaints', async (req, res) => {
    try {
        const queryText = `
            SELECT c.Complaint_ID, c.Status, c.Details
            FROM Complaints c
            JOIN Invoice_Complaints ic ON c.Complaint_ID = ic.Complaint_ID
            JOIN Invoice_List il ON ic.Inv_No = il.Inv_No
            WHERE il.UserID = $1;
        `;
        const result = await pool.query(queryText, [req.params.id]);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/consumer/:id/tariff', async (req, res) => {
    try {
        const queryText = `
            SELECT s.State_Name, s.Unit_Charge, s.Subsidy, s.Rebate_Per_Solar_Unit
            FROM State s
            JOIN User_State us ON s.State_Name = us.State_Name
            WHERE us.User_ID = $1;
        `;
        const result = await pool.query(queryText, [req.params.id]);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/consumer/:id/consumption-period', async (req, res) => {
    try {
        const { start, end } = req.query; // Expects ?start=2024-01-01&end=2024-04-01
        const queryText = `
            SELECT SUM(id.Units_Consumed) AS Total_Consumption
            FROM Invoice_List il
            JOIN Invoice_Details id ON il.Inv_No = id.Inv_No
            WHERE il.UserID = $1 AND il.Inv_Date BETWEEN $2 AND $3;
        `;
        const result = await pool.query(queryText, [req.params.id, start, end]);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ==========================================
// 2. ADMIN & EMPLOYEE OPERATIONS
// ==========================================
app.get('/api/admin/defaulters', async (req, res) => {
    try {
        const queryText = `
            SELECT c.User_ID, c.Cons_Name, il.Inv_No, il.Bill_Amt, il.Inv_Date
            FROM Consumer c
            JOIN Invoice_List il ON c.User_ID = il.UserID
            LEFT JOIN Payments p ON il.Payment_ID = p.Payment_ID
            WHERE p.Payment_ID IS NULL AND il.Inv_Date < CURRENT_DATE - INTERVAL '30 days';
        `;
        const result = await pool.query(queryText);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/negative-balance', async (req, res) => {
    try {
        const queryText = `
            SELECT c.User_ID, c.Cons_Name, il.Inv_No, il.Bill_Amt,
                   COALESCE(p.Amount_Paid, 0) AS Amount_Paid,
                   (COALESCE(p.Amount_Paid, 0) - il.Bill_Amt) AS Balance
            FROM Consumer c
            JOIN Invoice_List il ON c.User_ID = il.UserID
            LEFT JOIN Payments p ON il.Payment_ID = p.Payment_ID
            WHERE (COALESCE(p.Amount_Paid, 0) - il.Bill_Amt) < 0;
        `;
        const result = await pool.query(queryText);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/pending-complaints', async (req, res) => {
    try {
        const queryText = `
            SELECT c.User_ID, c.Cons_Name, comp.Complaint_ID, comp.Status
            FROM Consumer c
            JOIN Invoice_List il ON c.User_ID = il.UserID
            JOIN Invoice_Complaints ic ON il.Inv_No = ic.Inv_No
            JOIN Complaints comp ON ic.Complaint_ID = comp.Complaint_ID
            WHERE comp.Status IN ('Pending', 'In Progress');
        `;
        const result = await pool.query(queryText);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/admin/update-tariff', async (req, res) => {
    try {
        const { stateName, unitCharge, subsidy, rebate } = req.body;
        const queryText = `
            UPDATE State SET Unit_Charge = $1, Subsidy = $2, Rebate_Per_Solar_Unit = $3
            WHERE State_Name = $4 RETURNING *;
        `;
        const result = await pool.query(queryText, [unitCharge, subsidy, rebate, stateName]);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ==========================================
// 3. COMPLETE ANALYTICS 
// ==========================================

app.get('/api/analytics/users-per-state', async (req, res) => {
    try {
        const result = await pool.query(`SELECT State_Name, COUNT(User_ID) AS Total_Users FROM User_State GROUP BY State_Name ORDER BY Total_Users DESC;`);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/analytics/common-payment', async (req, res) => {
    try {
        const result = await pool.query(`SELECT Payment_Method, COUNT(*) AS Payment_Count FROM Payments GROUP BY Payment_Method ORDER BY Payment_Count DESC LIMIT 1;`);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/analytics/consumer-list', async (req, res) => {
    try {
        const result = await pool.query(`SELECT c.Cons_Name, c.Email, us.State_Name, us.Connection_Type FROM Consumer c JOIN User_State us ON c.User_ID = us.User_ID;`);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/analytics/solar-consumers', async (req, res) => {
    try {
        const result = await pool.query(`SELECT User_ID, Cons_Name, Email, Contact_No FROM Consumer WHERE Has_Solar = TRUE;`);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/analytics/employees', async (req, res) => {
    try {
        const result = await pool.query(`SELECT e.Emp_Name, e.Emp_Email, e.Contact_No, d.Dept_Name FROM Employee e JOIN Department d ON e.Dep_ID = d.Dep_ID;`);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/analytics/solar-ratio', async (req, res) => {
    try {
        const result = await pool.query(`SELECT ROUND(1.0 * (SELECT COUNT(*) FROM Consumer WHERE Has_Solar = TRUE) / (SELECT COUNT(*) FROM Consumer), 2) AS Solar_Rebate_Ratio;`);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/analytics/complaint-stats', async (req, res) => {
    try {
        const { start, end } = req.query; // Ex: ?start=2024-04-01&end=2024-04-01
        const queryText = `
            SELECT comp.Status, COUNT(*) AS Complaint_Count FROM Complaints comp
            JOIN Invoice_Complaints ic ON comp.Complaint_ID = ic.Complaint_ID
            JOIN Invoice_List il ON ic.Inv_No = il.Inv_No
            WHERE il.Inv_Date BETWEEN $1 AND $2 GROUP BY comp.Status;
        `;
        const result = await pool.query(queryText, [start, end]);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/analytics/dept-consumption', async (req, res) => {
    try {
        const queryText = `
            SELECT d.Dept_Name, SUM(id.Units_Consumed) AS Total_Consumption
            FROM Department d JOIN Handling_Complaints hc ON d.Dep_ID = hc.Department_ID
            JOIN Complaints comp ON hc.Complaint_ID = comp.Complaint_ID
            JOIN Invoice_Complaints ic ON comp.Complaint_ID = ic.Complaint_ID
            JOIN Invoice_List il ON ic.Inv_No = il.Inv_No
            JOIN Invoice_Details id ON il.Inv_No = id.Inv_No GROUP BY d.Dept_Name;
        `;
        const result = await pool.query(queryText);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/analytics/top-states-consumption', async (req, res) => {
    try {
        const queryText = `
            SELECT s.State_Name, ROUND(AVG(id.Units_Consumed), 2) AS Avg_Monthly_Consumption
            FROM State s JOIN User_State us ON s.State_Name = us.State_Name
            JOIN Invoice_List il ON us.User_ID = il.UserID JOIN Invoice_Details id ON il.Inv_No = id.Inv_No
            WHERE il.Inv_Date >= '2024-01-01' AND il.Inv_Date < '2025-01-01'
            GROUP BY s.State_Name ORDER BY Avg_Monthly_Consumption DESC LIMIT 2;
        `;
        const result = await pool.query(queryText);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/analytics/high-solar-generators', async (req, res) => {
    try {
        const queryText = `
            SELECT il.UserID, il.Inv_No, id.Solar_Units_Gen, id.Units_Consumed
            FROM Invoice_List il JOIN Invoice_Details id ON il.Inv_No = id.Inv_No
            WHERE id.Solar_Units_Gen > id.Units_Consumed;
        `;
        const result = await pool.query(queryText);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/analytics/complaints-per-user', async (req, res) => {
    try {
        const queryText = `
            SELECT c.User_ID, c.Cons_Name, COUNT(ic.Complaint_ID) AS Total_Complaints
            FROM Invoice_Complaints ic JOIN Invoice_List il ON ic.Inv_No = il.Inv_No
            JOIN Consumer c ON il.UserID = c.User_ID GROUP BY c.User_ID, c.Cons_Name ORDER BY Total_Complaints DESC;
        `;
        const result = await pool.query(queryText);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/analytics/top-net-generation', async (req, res) => {
    try {
        const queryText = `
            SELECT c.User_ID, c.Cons_Name, SUM(id.Solar_Units_Gen) AS Total_Solar, SUM(id.Units_Consumed) AS Total_Consumed,
            SUM(id.Units_Consumed - id.Solar_Units_Gen) AS Net_Generation
            FROM Invoice_List il JOIN Invoice_Details id ON il.Inv_No = id.Inv_No
            JOIN Consumer c ON il.UserID = c.User_ID 
            GROUP BY c.User_ID, c.Cons_Name HAVING SUM(id.Units_Consumed) > SUM(id.Solar_Units_Gen)
            ORDER BY Net_Generation DESC LIMIT 3;
        `;
        const result = await pool.query(queryText);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/analytics/above-avg-consumption', async (req, res) => {
    try {
        const queryText = `
            WITH UserConsumption AS (
                SELECT il.UserID, SUM(id.Units_Consumed) AS total FROM Invoice_List il JOIN Invoice_Details id ON il.Inv_No = id.Inv_No GROUP BY il.UserID
            ), Average AS (SELECT AVG(total) AS avg_total FROM UserConsumption)
            SELECT u.User_ID, u.Cons_Name FROM Consumer u JOIN UserConsumption uc ON u.User_ID = uc.UserID JOIN Average a ON TRUE
            WHERE uc.total > a.avg_total;
        `;
        const result = await pool.query(queryText);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/analytics/highest-bill-users', async (req, res) => {
    try {
        const queryText = `
            WITH MaxBills AS (SELECT UserID, MAX(Bill_Amt) AS Max_Bill FROM Invoice_List GROUP BY UserID)
            SELECT DISTINCT c.User_ID, c.Cons_Name FROM Consumer c
            JOIN Invoice_List il ON c.User_ID = il.UserID
            JOIN MaxBills mb ON il.UserID = mb.UserID AND il.Bill_Amt = mb.Max_Bill;
        `;
        const result = await pool.query(queryText);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/analytics/national-avg-states', async (req, res) => {
    try {
        const queryText = `
            WITH StateAvgs AS (
                SELECT us.State_Name, AVG(il.Bill_Amt) AS Avg_State_Bill FROM User_State us JOIN Invoice_List il ON us.User_ID = il.UserID GROUP BY us.State_Name
            ), NationalAvg AS (SELECT AVG(Bill_Amt) AS National_Avg FROM Invoice_List)
            SELECT sa.State_Name FROM StateAvgs sa, NationalAvg na WHERE sa.Avg_State_Bill > na.National_Avg;
        `;
        const result = await pool.query(queryText);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Exhaustive Full-Stack Database System running on port ${PORT}`));