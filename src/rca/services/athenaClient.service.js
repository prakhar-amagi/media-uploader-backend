import {
  AthenaClient,
  StartQueryExecutionCommand,
  GetQueryExecutionCommand,
  GetQueryResultsCommand
} from "@aws-sdk/client-athena";

import { fromIni } from "@aws-sdk/credential-providers";


export async function runAthenaQuery({
  query,
  region,
  database,
  outputLocation,
  profile,
  maxRows = 50000,
  workGroup = process.env.ATHENA_WORKGROUP || undefined,
  onStarted
}) {

  console.log("\nConnecting to Athena...");
  console.log(`Region: ${region}`);
  console.log(`Database: ${database}`);
  console.log(`Output: ${outputLocation}`);

  const client = new AthenaClient({
    region,

    credentials: fromIni({
      profile
    })
  });


  // --------------------------------------------------
  // Start Athena query
  // --------------------------------------------------

  console.log("\nStarting Athena query...");

  const startResponse = await client.send(
    new StartQueryExecutionCommand({

      QueryString: query,

      ...(workGroup ? { WorkGroup: workGroup } : {}),

      QueryExecutionContext: {
        Database: database
      },

      ResultConfiguration: {
        OutputLocation: outputLocation
      }
    })
  );


  const queryExecutionId =
    startResponse.QueryExecutionId;


  if (!queryExecutionId) {
    throw new Error(
      "Athena did not return a QueryExecutionId"
    );
  }


  console.log(
    `Query ID: ${queryExecutionId}`
  );

  if (typeof onStarted === "function") {
    onStarted(queryExecutionId);
  }


  // --------------------------------------------------
  // Wait for query
  // --------------------------------------------------

  while (true) {

    const response = await client.send(
      new GetQueryExecutionCommand({
        QueryExecutionId: queryExecutionId
      })
    );


    const execution =
      response.QueryExecution;

    const state =
      execution?.Status?.State;


    console.log(
      `Athena status: ${state}`
    );


    if (state === "SUCCEEDED") {
      break;
    }


    if (
      state === "FAILED" ||
      state === "CANCELLED"
    ) {

      const reason =
        execution?.Status?.StateChangeReason ||
        "Unknown Athena error";


      // Attach execution details so callers can show
      // WHY / after how long / how much data — not just a string.
      const error = new Error(
        `Athena query ${state}: ${reason}`
      );

      error.athena = {
        queryExecutionId,
        state,
        reason,
        workGroup: execution?.WorkGroup || workGroup || "primary",
        errorCategory: execution?.Status?.AthenaError?.ErrorCategory ?? null,
        errorType: execution?.Status?.AthenaError?.ErrorType ?? null,
        errorMessage: execution?.Status?.AthenaError?.ErrorMessage ?? null,
        submittedAt: execution?.Status?.SubmissionDateTime?.toISOString?.() ?? null,
        completedAt: execution?.Status?.CompletionDateTime?.toISOString?.() ?? null,
        dataScannedBytes: execution?.Statistics?.DataScannedInBytes ?? null,
        engineExecutionMs: execution?.Statistics?.EngineExecutionTimeInMillis ?? null,
        queueMs: execution?.Statistics?.QueryQueueTimeInMillis ?? null,
        totalExecutionMs: execution?.Statistics?.TotalExecutionTimeInMillis ?? null,
      };

      throw error;
    }


    await new Promise(
      resolve => setTimeout(resolve, 2000)
    );
  }


  // --------------------------------------------------
  // Retrieve results (paginated)
  //
  // GetQueryResults returns at most 1000 rows per call, so
  // follow NextToken until exhausted. Only the FIRST page
  // contains the header row. maxRows is a safety cap.
  // --------------------------------------------------

  console.log(
    "\nRetrieving Athena results..."
  );

  const allRows = [];
  let nextToken;

  do {
    const page = await client.send(
      new GetQueryResultsCommand({
        QueryExecutionId: queryExecutionId,
        NextToken: nextToken,
        MaxResults: 1000
      })
    );

    allRows.push(...(page?.ResultSet?.Rows || []));
    nextToken = page?.NextToken;
  } while (nextToken && allRows.length < maxRows + 1);


  return convertAthenaRows(allRows);
}


// --------------------------------------------------
// Convert Athena rows (first row = header) into JSON
// --------------------------------------------------

function convertAthenaRows(rows) {

  if (!rows.length) {
    return [];
  }


  const headers =
    rows[0].Data.map(
      column => column.VarCharValue
    );


  return rows
    .slice(1)
    .map(row => {

      const values =
        (row.Data || []).map(
          column => column?.VarCharValue ?? null
        );


      return Object.fromEntries(

        headers.map(
          (header, index) => [
            header,
            values[index] ?? null
          ]
        )

      );
    });
}
