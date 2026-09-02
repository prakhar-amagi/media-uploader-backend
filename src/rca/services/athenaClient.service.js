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
  profile
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


      throw new Error(
        `Athena query ${state}: ${reason}`
      );
    }


    await new Promise(
      resolve => setTimeout(resolve, 2000)
    );
  }


  // --------------------------------------------------
  // Retrieve results
  // --------------------------------------------------

  console.log(
    "\nRetrieving Athena results..."
  );


  const resultResponse = await client.send(
    new GetQueryResultsCommand({
      QueryExecutionId: queryExecutionId
    })
  );


  return convertAthenaResults(
    resultResponse
  );
}


// --------------------------------------------------
// Convert Athena response into normal JSON
// --------------------------------------------------

function convertAthenaResults(result) {

  const rows =
    result?.ResultSet?.Rows || [];


  if (rows.length === 0) {
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
        row.Data.map(
          column => column.VarCharValue ?? null
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
