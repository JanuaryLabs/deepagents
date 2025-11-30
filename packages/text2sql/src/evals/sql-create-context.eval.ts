/* eslint-disable @nx/enforce-module-boundaries */
import { Levenshtein, Sql } from 'autoevals';
import { evalite } from 'evalite';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import OpenAI from 'openai';

import { InMemoryHistory, Text2Sql } from '@deepagents/text2sql';
import { Sqlite } from '@deepagents/text2sql/sqlite';

const groq = new OpenAI({
  apiKey: process.env['GROQ_API_KEY'],
  baseURL: 'https://api.groq.com/openai/v1',
});

// Sample data from sql-create-context dataset
// In a real scenario, you would fetch this from Hugging Face
// URL: https://huggingface.co/datasets/b-mc2/sql-create-context/resolve/main/sql_create_context_v4.json
interface Sample{
  question: string;
  context: string;
  answer: string;
}
const DATASET_SAMPLE: Sample[] = [
  // {
  //   question:
  //     'Please show the themes of competitions with host cities having populations larger than 1000.',
  //   context:
  //     'CREATE TABLE city (City_ID VARCHAR, Population INTEGER); CREATE TABLE farm_competition (Theme VARCHAR, Host_city_ID VARCHAR)',
  //   answer:
  //     'SELECT T2.Theme FROM city AS T1 JOIN farm_competition AS T2 ON T1.City_ID = T2.Host_city_ID WHERE T1.Population > 1000',
  // },
  // {
  //   question:
  //     'Please show the different statuses of cities and the average population of cities with each status.',
  //   context: 'CREATE TABLE city (Status VARCHAR, Population INTEGER)',
  //   answer: 'SELECT Status, AVG(Population) FROM city GROUP BY Status',
  // },
  // {
  //   question: 'How many heads of the departments are older than 56 ?',
  //   context: 'CREATE TABLE head (age INTEGER)',
  //   answer: 'SELECT COUNT(*) FROM head WHERE age > 56',
  // },
  // {
  //   question:
  //     'List the name, born state and age of the heads of departments ordered by age.',
  //   context:
  //     'CREATE TABLE head (name VARCHAR, born_state VARCHAR, age VARCHAR)',
  //   answer: 'SELECT name, born_state, age FROM head ORDER BY age',
  // },
  // {
  //   question: 'List the creation year, name and budget of each department.',
  //   context:
  //     'CREATE TABLE department (creation VARCHAR, name VARCHAR, budget_in_billions VARCHAR)',
  //   answer: 'SELECT creation, name, budget_in_billions FROM department',
  // },
];

evalite('SQL Create Context', {
  data: () =>
    DATASET_SAMPLE.map((item) => ({
      input: {
        question: item.question,
        context: item.context,
      },
      expected: item.answer,
    })),
  task: async (input) => {
    // Create an in-memory SQLite database for each task to isolate schema
    const db = new DatabaseSync(':memory:');

    // Execute the context (CREATE TABLE statements)
    try {
      db.exec(input.context);
    } catch (e) {
      throw new Error(`Failed to setup database context: ${e}`);
    }

    // Initialize the Text2Sql agent with the in-memory adapter
    const adapter = new Sqlite({
      grounding: [],
      execute: (sql) => {
        try {
          return db.prepare(sql).all();
        } catch (e) {
          // If it's an explain query or similar that returns no data but succeeds
          if (sql.trim().toUpperCase().startsWith('EXPLAIN')) {
            return [];
          }
          throw e;
        }
      },
    });

    // We need to introspect the database to get the schema for the agent
    // The Text2Sql agent uses the adapter to get the schema
    // We can pass a history object, but for this eval we don't need persistence
    // We can use a dummy history or in-memory one if available, or just a file one that we clean up
    // For now, we'll use a temporary file or just let it create one
    // Actually, Text2Sql requires history. Let's use a dummy one or the existing SqliteHistory
    // We'll use a unique history file per run or just a shared one since we don't care about history here

    const text2sql = new Text2Sql({
      version: randomUUID(), // Use unique version per run for cache isolation
      history: new InMemoryHistory(),
      adapter,
    });

    // Generate SQL
    // The agent will introspect the adapter which will read from our in-memory db
    return text2sql.toSql(input.question);
  },
  scorers: [
    {
      name: 'SQL Semantic Match',
      scorer: async ({ output, expected, input }) => {
        const result = await Sql({
          output: String(output),
          expected: String(expected),
          input: JSON.stringify(input),
          client: groq as never,
          model: 'llama-3.3-70b-versatile',
        });
        return result.score ?? 0;
      },
    },
    {
      name: 'String Similarity',
      scorer: async ({ output, expected }) => {
        const result = await Levenshtein({
          output: String(output),
          expected: String(expected),
        });
        return result.score ?? 0;
      },
    },
  ],
});
