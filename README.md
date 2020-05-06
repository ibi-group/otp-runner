# otp-runner

Scripts to assemble data and run OpenTripPlanner.

### Usage:

```shell
$ sudo yarn start
```

In order to run this script, a file called `manifest.json` must be created in the root of this directory. This file should contain all of the information required to run OpenTripPlanner in the ways that are desired.

### Manifest.json values

*The rest of this README contains auto-generated contents via the `yarn update-docs` script and should not be directly edited!*

| Key | Type | Required | Default | Description |
| - | - | - | - | - |
| buildConfigJSON | string | Optional | | The raw contents to write to the build-config.json file. |
| buildGraph | boolean | Optional | true | If true, run OpenTripPlanner in build mode |
| buildLogFile | string | Optional | /var/log/otp-build.log | The path where the build logs should be written to. |
| graphObjUrl | string | Optional | | A url where the graph.obj should be downloaded from for server-only runs. If `uploadGraph` is set to true, this value must be an s3 url that can be uplaoded to. |
| graphsFolder | string | Optional | /var/otp/graphs | The folder where the graphs should be stored. |
| gtfsAndOsmUrls | array | Optional | | An array of GTFS and OSM urls that should be downloaded. |
| jarFile | string | Optional | /opt/otp-1.4.0-shaded.jar | The full path to the OTP jar file. |
| jarUrl | string | Optional | https://repo1.maven.org/maven2/org/opentripplanner/otp/1.4.0/otp-1.4.0-shaded.jar | A url where the OTP jar can be downloaded from. |
| otpRunnerLogFile | string | Optional | /var/log/otp-runner.log | The path where the otp-runner logs should be written to. |
| routerConfigJSON | string | Optional | | The raw contents to write to the router-config.json file. |
| routerName | string | Optional | default | The name of the OTP router. |
| runServer | boolean | Optional | true | If true, run OTP as a server. |
| s3UploadBucket | string | Optional | | The base path of an s3 bucket where files will be uploaded to. |
| serverLogFile | string | Optional | /var/log/otp-server.log | The file location to write server logs to. |
| serverStartupTimeoutSeconds | number | Optional | 300 | The amount of time to wait for a successful server startup before failing. |
| statusFileLocation | string | Optional | status.json | The file location to write status updates about this script to. |
| uploadGraphBuildLogs | boolean | Optional | false | If true, the logs from a graph build will be uploaded to the provided s3 bucket to the path `${s3UploadBucket}/otp-build.log`. Note: if this is set to true, `s3UploadBucket` must be defined. |
| uploadGraphBuildReport | boolean | Optional | false | If true, the OTP-generated graph build report will be zipped up and uploaded to the provided s3 bucket to the path `${s3UploadBucket}/graph-build-report.zip`. Note: if this is set to true, `s3UploadBucket` must be defined. |
| uploadGraph | boolean | Optional | false | If true, the graph.obj file will be uploaded after graph build. Note: if this is set to true, `graphObjUrl` must be defined and be a valid AWS s3 path. |
| uploadOtpRunnerLogs | boolean | Optional | false | If true, the logs from the otp-runner script will be uploaded to the provided s3 bucket to the path `${s3UploadBucket}/otp-runner.log`. Note: if this is set to true, `s3UploadBucket` must be defined. |
| uploadServerStartupLogs | boolean | Optional | false | If true, the logs from the server startup will be uploaded to the provided s3 bucket to the path `${s3UploadBucket}/otp-server.log`. Note: if this is set to true, `s3UploadBucket` must be defined. |