# otp-runner

Scripts to assemble data and run OpenTripPlanner.

## Usage:

```shell
$ cp example-manifest.json manifest.json
$ sudo yarn start
```

In order to run this script, a file called `manifest.json` with valid JSON must be created in the root of this directory. This file should contain all of the information required to run OpenTripPlanner in the ways that are desired. Values to put in this manifest are detailed in the [Manifest.json values section](https://github.com/ibi-group/otp-runner#manifestjson-values).

A number of default parameters will instruct otp-runner to write files to various directories within the `/var` folder. Therefore, the above example uses `sudo`. But the sudo command is not needed if files are written to other directories.

### status.json

otp-runner will write a JSON status file with useful information as it runs. The following fields that get written to are as follows:

| Key | Type | Description |
| - | - | - |
| error | Boolean | True if a fatal error occurred while running otp-runner. |
| graphBuilt | Boolean | True if a graph was successfully built. |
| graphUploaded | Boolean | True if a Graph.obj file was successfully uploaded to AWS S3. |
| serverStarted | Boolean | True if the server was successfully started (graph was read and server is ready to accept requests). |
| message | String | A description of the current status of the script. |
| numFilesDownloaded | Number | The number of files that have been downloaded so far. |
| pctProgress | Number | The overall percent progress (on a scale of 0-100) that is estimated to have been completed so far. |
| totalFilesToDownload | Number | The total number of files that need to be downloaded. |

## Configuration

When running otp-runner, a number of default values will be used when parsing the manifest. These values will dictate whether or not to build a graph with OTP and whether or not to run OTP as a server. The default actions that occur are as follows:

1. The manifest.json file will be validated
1. The router folder will be deleted and recreated to remove any lingering files from previous runs
1. All applicable GTFS, OSM and OTP jar files will be downloaded asynchronously
1. OTP will build a Graph
1. OTP will be ran as a server

### Downloading/Uploading to AWS S3

It is possible to download files from AWS S3 as long as the proper AWS S3 url is included. For example, if you wanted to download a GTFS file from s3 you could specify: `s3://example-bucket/gtfs.zip`. If any of the `upload*` parameters are set, the `s3UploadPath` must also be provided. Also, the `aws` command line tool and proper credentials to upload to AWS S3 must be setup in order for this script to properly upload files.

### manifest.json values

*The rest of this README contains auto-generated contents via the `yarn update-readme` script and should not be directly edited!*

| Key | Type | Required | Default | Description |
| - | - | - | - | - |
| baseFolder | string | Optional | /var/otp/graphs | The base directory for storing files. If `otpVersion` is set to `1.x`, then an additional folder inside the base folder will be written with the name found in the manifest value `routerName` and that additional folder will be where files are stored (for example `/var/otp/graphs/default`). If `otpVersion` is set to 2.x, then this folder itself will be used for storing files. |
| baseFolderDownloads | array | Optional | | An array of items that should be downloaded to the base folder (see description in `baseFolder` for what this folder will be). This can includes items such as GTFS files, OSM data, build-config.json, router-config.json or elevation files. Each item must be an object. Each item must have the `uri` property which must be either an HTTP(S) URL or AWS S3 URI. Each item can optionally have a `name` property which will be the name that the file will be given when it is downloaded. If `name` is omitted, then the filename will be whatever is after the final forward slash in the `uri` field. |
| buildConfigJSON | string | Optional | | The raw contents to write to the build-config.json file. |
| buildGraph | boolean | Optional | true | If true, run OpenTripPlanner in build mode. If this flag and the `runServer` flag are both false, an error will occur. |
| buildLogFile | string | Optional | /var/log/otp-build.log | The path where the build logs should be written to. |
| graphObjUri | string | Optional | | Either an HTTP(S) URL or AWS S3 URI where the Graph.obj should be downloaded from for server-only runs. If `buildGraph` is set to false and `runServer` is set to true, this value must be defined. If `uploadGraph` is set to true, this value must be an AWS S3 URI that can be uploaded to. |
| jarFile | string | Optional | /opt/otp-1.4.0-shaded.jar | The full path to the OTP jar file. |
| jarUri | string | Optional | https://repo1.maven.org/maven2/org/opentripplanner/otp/1.4.0/otp-1.4.0-shaded.jar | Either an HTTP(S) URL or AWS S3 URI where the OTP jar can be downloaded from. |
| nonce | string | Optional | | A value that will be written in status.json files in order to verify that the status file was produced by a particular run with the provided config. |
| otpRunnerLogFile | string | Optional | /var/log/otp-runner.log | The path where the otp-runner logs should be written to. |
| otpVersion | | Optional | 1.x | The major version of OTP that is being used. Must be either `1.x` or `2.x`. This is used in order to generate the appropriate command line parameters to run OTP with. |
| prefixLogUploadsWithInstanceId | boolean | Optional | false | If true, will obtain the ec2 instance ID and prefix the otp-runner and otp-server log files with this instance ID when uploading to AWS S3. |
| routerConfigJSON | string | Optional | | The raw contents to write to the router-config.json file. |
| routerName | string | Optional | default | The name of the OTP router. |
| runServer | boolean | Optional | true | If true, run OTP as a server.  If this flag and the `buildGraph` flag are both false, an error will occur. |
| s3UploadPath | string | Optional | | The base AWS S3 URI of where files will be uploaded to. Ex: `s3://bucket-name/folder` |
| serverLogFile | string | Optional | /var/log/otp-server.log | The file location to write server logs to. |
| serverStartupTimeoutSeconds | number | Optional | 300 | The amount of time to wait for a successful server startup (server initialization and graph read) before failing. |
| statusFileLocation | string | Optional | status.json | The file location to write status updates about this script to. |
| uploadGraphBuildLogs | boolean | Optional | false | If true, the logs from a graph build will be uploaded to the provided AWS S3 bucket to the path `${s3UploadPath}/otp-build.log`. Note: if this is set to true, `s3UploadPath` must be defined. |
| uploadGraphBuildReport | boolean | Optional | false | If true, the OTP-generated graph build report will be zipped up and uploaded to the provided AWS S3 bucket to the path `${s3UploadPath}/graph-build-report.zip`. Note: if this is set to true, `s3UploadPath` must be defined. |
| uploadGraph | boolean | Optional | false | If true, the Graph.obj file will be uploaded after graph build. Note: if this is set to true, `graphObjUri` must be defined and be a valid AWS S3 URI. |
| uploadOtpRunnerLogs | boolean | Optional | false | If true, the logs from the otp-runner script will be uploaded to the provided AWS S3 bucket to the path `${s3UploadPath}/otp-runner.log`. Note: if this is set to true, `s3UploadPath` must be defined. |
| uploadServerStartupLogs | boolean | Optional | false | If true, the logs from the server startup will be uploaded to the provided AWS S3 bucket to the path `${s3UploadPath}/otp-server.log`. Note: if this is set to true, `s3UploadPath` must be defined. |