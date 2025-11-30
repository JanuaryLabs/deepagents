/* eslint-disable @nx/enforce-module-boundaries */
import { Sql } from 'autoevals';
import { evalite } from 'evalite';
import { DatabaseSync } from 'node:sqlite';
import OpenAI from 'openai';

import { InMemoryHistory, Text2Sql } from '@deepagents/text2sql';
import { Sqlite } from '@deepagents/text2sql/sqlite';

const groq = new OpenAI({
  apiKey: process.env['GROQ_API_KEY'],
  baseURL: 'https://api.groq.com/openai/v1',
});

const QUESTIONS = [
  {
    question:
      'Provide a query showing Customers (just their full names, customer ID and country) who are not in the US.',
    expectedSql: `SELECT FirstName || ' ' || LastName AS Name, CustomerId, Country FROM Customer WHERE Country <> 'USA';`,
  },
  // {
  //   question: 'Provide a query only showing the Customers from Brazil.',
  //   expectedSql: `SELECT * FROM Customer WHERE Country IS 'Brazil';`,
  // },
  // {
  //   question:
  //     "Provide a query showing the Invoices of customers who are from Brazil. The resultant table should show the customer's full name, Invoice ID, Date of the invoice and billing country.",
  //   expectedSql: `SELECT c.FirstName || ' ' || c.LastName as Name, i.InvoiceId, i.InvoiceDate, c.Country FROM Customer c LEFT JOIN Invoice i ON i.CustomerId = c.CustomerId WHERE c.Country IS 'Brazil';`,
  // },
  // {
  //   question:
  //     'Provide a query showing only the Employees who are Sales Agents.',
  //   expectedSql: `SELECT * FROM Employee WHERE Title LIKE '%Sale%Agent%';`,
  // },
  // {
  //   question:
  //     'Provide a query showing a unique list of billing countries from the Invoice table.',
  //   expectedSql: `SELECT BillingCountry FROM Invoice GROUP BY BillingCountry;`,
  // },
  // {
  //   question:
  //     "Provide a query that shows the invoices associated with each sales agent. The resultant table should include the Sales Agent's full name.",
  //   expectedSql: `SELECT i.*, e.FirstName || ' ' || e.LastName AS SalesAgentName FROM Invoice i JOIN Customer c ON i.CustomerId = c.CustomerId JOIN Employee e ON c.SupportRepId = e.EmployeeId WHERE e.Title LIKE '%Sale%Agent%';`,
  // },
  // {
  //   question:
  //     'Provide a query that shows the Invoice Total, Customer name, Country and Sale Agent name for all invoices and customers.',
  //   expectedSql: `SELECT (c.FirstName || ' ' || c.LastName) as CustomerName, (e.FirstName || ' ' || e.LastName) as SalesAgentName, i.Total, i.BillingCountry FROM Invoice i LEFT JOIN Customer c ON c.CustomerId = i.CustomerId LEFT JOIN Employee e ON c.SupportRepId = e.EmployeeId;`,
  // },
  // {
  //   question:
  //     'How many Invoices were there in 2009 and 2011? What are the respective total sales for each of those years?',
  //   expectedSql: `SELECT strftime('%Y', InvoiceDate) AS Year, COUNT(*) AS Invoices, SUM(Total) AS Sales FROM Invoice WHERE strftime('%Y', InvoiceDate) IN ('2009', '2011') GROUP BY Year ORDER BY Year;`,
  // },
  // {
  //   question:
  //     'Looking at the InvoiceLine table, provide a query that COUNTs the number of line items for Invoice ID 37.',
  //   expectedSql: `SELECT COUNT(*) FROM InvoiceLine il WHERE il.InvoiceId = 37;`,
  // },
  // {
  //   question:
  //     'Looking at the InvoiceLine table, provide a query that COUNTs the number of line items for each Invoice.',
  //   expectedSql: `SELECT InvoiceId, COUNT(*) FROM InvoiceLine il GROUP BY InvoiceId;`,
  // },
  // {
  //   question:
  //     'Provide a query that includes the track name with each invoice line item.',
  //   expectedSql: `SELECT t.Name, il.* FROM InvoiceLine il LEFT JOIN Track t ON t.TrackId = il.TrackId;`,
  // },
  // {
  //   question:
  //     'Provide a query that includes the purchased track name AND artist name with each invoice line item.',
  //   expectedSql: `SELECT il.InvoiceLineId, il.InvoiceId, t.Name AS TrackName, ar.Name AS ArtistName, il.UnitPrice, il.Quantity FROM InvoiceLine il JOIN Track t ON il.TrackId = t.TrackId JOIN Album al ON t.AlbumId = al.AlbumId JOIN Artist ar ON al.ArtistId = ar.ArtistId ORDER BY il.InvoiceLineId;`,
  // },
  // {
  //   question: 'Provide a query that shows the # of invoices per country.',
  //   expectedSql: `SELECT Invoice.BillingCountry, COUNT(*) FROM Invoice GROUP BY BillingCountry;`,
  // },
  // {
  //   question:
  //     'Provide a query that shows the total number of tracks in each playlist. The Playlist name should be included on the resultant table.',
  //   expectedSql: `SELECT p.Name, COUNT(*) FROM Playlist p LEFT JOIN PlaylistTrack pt ON pt.PlaylistId = p.PlaylistId GROUP BY pt.PlaylistId;`,
  // },
  // {
  //   question:
  //     'Provide a query that shows all the Tracks, but displays no IDs. The resultant table should include the Album name, Media type and Genre.',
  //   expectedSql: `SELECT t.Name AS Song, a.Title as Album, mt.Name AS MediaType, g.Name AS Genre FROM Track t LEFT JOIN MediaType mt on mt.MediaTypeId = t.MediaTypeId LEFT JOIN Album a ON a.AlbumId = t.AlbumId LEFT JOIN Genre g ON g.GenreId = t.GenreId;`,
  // },
  // {
  //   question:
  //     'Provide a query that shows all Invoices but includes the # of invoice line items.',
  //   expectedSql: `SELECT i.*, COUNT(*) as LineCount FROM Invoice i LEFT JOIN InvoiceLine il ON i.InvoiceId = il.InvoiceId GROUP BY i.InvoiceId;`,
  // },
  // {
  //   question:
  //     'Provide a query that shows total sales made by each sales agent.',
  //   expectedSql: `SELECT e.FirstName || ' ' || e.lastName as Name, COUNT(*) AS Sales FROM Employee e JOIN Customer c ON c.SupportRepId = e.EmployeeId JOIN Invoice i ON i.CustomerId = c.CustomerId GROUP BY EmployeeId;`,
  // },
  // {
  //   question: 'Which sales agent made the most in sales in 2009?',
  //   expectedSql: `SELECT e.FirstName || ' ' || e.lastName as Name, COUNT(*) AS Sales FROM Employee e JOIN Customer c ON c.SupportRepId = e.EmployeeId JOIN Invoice i ON i.CustomerId = c.CustomerId WHERE SUBSTR(i.InvoiceDate,0,5) = '2009' GROUP BY EmployeeId ORDER BY Sales DESC;`,
  // },
  // {
  //   question: 'Which sales agent made the most in sales in 2010?',
  //   expectedSql: `SELECT e.FirstName || ' ' || e.lastName as Name, COUNT(*) AS Sales FROM Employee e JOIN Customer c ON c.SupportRepId = e.EmployeeId JOIN Invoice i ON i.CustomerId = c.CustomerId WHERE SUBSTR(i.InvoiceDate,0,5) = '2010' GROUP BY EmployeeId ORDER BY Sales DESC;`,
  // },
  // {
  //   question: 'Which sales agent made the most in sales over all?',
  //   expectedSql: `SELECT e.FirstName || ' ' || e.lastName as Name, COUNT(*) AS Sales FROM Employee e JOIN Customer c ON c.SupportRepId = e.EmployeeId JOIN Invoice i ON i.CustomerId = c.CustomerId GROUP BY EmployeeId ORDER BY Sales DESC;`,
  // },
  // {
  //   question:
  //     'Provide a query that shows the # of customers assigned to each sales agent.',
  //   expectedSql: `SELECT e.EmployeeId, e.FirstName || ' ' || e.LastName as Employee, COUNT(*) FROM Customer c JOIN Employee e ON e.EmployeeId = c.SupportRepId GROUP BY e.EmployeeId;`,
  // },
  // {
  //   question:
  //     "Provide a query that shows the total sales per country. Which country's customers spent the most?",
  //   expectedSql: `SELECT BillingCountry, SUM(Total) FROM Invoice GROUP BY BillingCountry ORDER BY SUM(Total) DESC;`,
  // },
  // {
  //   question: 'Provide a query that shows the most purchased track of 2013.',
  //   expectedSql: `SELECT t.TrackId, COUNT(*) FROM InvoiceLine il JOIN Track t ON t.TrackId = il.TrackId JOIN Invoice i ON i.InvoiceId = il.InvoiceId WHERE SUBSTR(i.InvoiceDate,0,5) = '2013' GROUP BY il.TrackId ORDER BY COUNT(*) DESC;`,
  // },
  // {
  //   question:
  //     'Provide a query that shows the top 5 most purchased tracks over all.',
  //   expectedSql: `SELECT t.TrackId, COUNT(*) FROM InvoiceLine il JOIN Track t ON t.TrackId = il.TrackId GROUP BY il.TrackId ORDER BY COUNT(*) DESC;`,
  // },
  // {
  //   question: 'Provide a query that shows the top 3 best selling artists.',
  //   expectedSql: `SELECT ar.Name, COUNT(*) FROM InvoiceLine il LEFT JOIN Track t ON t.TrackId = il.TrackId LEFT JOIN Album al ON al.AlbumId = t.AlbumId LEFT JOIN Artist ar ON ar.ArtistId = al.ArtistId GROUP BY ar.ArtistId ORDER BY COUNT(*) DESC LIMIT 3;`,
  // },
  // {
  //   question: 'Provide a query that shows the most purchased Media Type.',
  //   expectedSql: `SELECT mt.Name, COUNT(*) FROM InvoiceLine il LEFT JOIN Track t ON t.TrackId = il.TrackId LEFT JOIN MediaType mt ON mt.MediaTypeId = t.MediaTypeId GROUP BY t.MediaTypeId ORDER BY COUNT(*) DESC;`,
  // },
  // {
  //   question:
  //     'Provide a query that shows the number tracks purchased in all invoices that contain more than one genre.',
  //   expectedSql: `SELECT COUNT(track.trackid) AS "Tracks", invoice.invoiceid AS "Total Invoices", COUNT(DISTINCT genre.genreid) AS "Genres" FROM Track JOIN InvoiceLine JOIN Invoice JOIN Genre WHERE track.trackid = invoiceline.trackid AND invoiceline.invoiceid = invoice.invoiceid AND track.genreid = genre.genreid GROUP BY invoice.invoiceid HAVING COUNT(DISTINCT genre.genreid) > 1`,
  // },
];

// Initialize database connection (shared across all tasks)
const sqliteClient = new DatabaseSync(
  '/Users/ezzabuzaid/Downloads/Chinook.db',
  { readOnly: true },
);

evalite('Chinook Text2SQL', {
  data: () =>
    QUESTIONS.map((q) => ({
      input: q.question,
      expected: q.expectedSql,
    })),
  task: async (question) => {
    const text2sql = new Text2Sql({
      version: 'chinook-eval',
      history: new InMemoryHistory(),
      adapter: new Sqlite({
        grounding: [],
        execute: (sql) => sqliteClient.prepare(sql).all(),
      }),
    });

    return text2sql.toSql(question);
  },
  scorers: [
    {
      name: 'SQL Semantic Match',
      scorer: async ({ output, expected, input }) => {
        const result = await Sql({
          output: String(output),
          expected: String(expected),
          input: String(input),
          client: groq as never,
          model: 'llama-3.3-70b-versatile',
        });
        return result.score ?? 0;
      },
    },
  ],
});
