# otp-runner

Scripts to assemble data and run OpenTripPlanner.

## Usage:

```shell
$ cp example-manifest.json manifest.json
$ sudo yarn start
```

In order to run this script, a file called `manifest.json` with valid JSON must be created in the root of this directory. This file should contain all of the information required to run OpenTripPlanner in the ways that are desired. Values to put in this manifest are detailed in the [Manifest.json values section](https://github.com/ibi-group/otp-runner#manifestjson-values).

A number of default parameters will instruct otp-runner to write files to various directories within the `/var` folder. Therefore, the above example uses `sudo`. But the sudo command is not needed if files are written to other directories.

## Configuration

When running otp-runner, a number of default values will be used when parsing the manifest. These values will dictate whether or not to build a graph with OTP and whether or not to run OTP as a server. The default actions that occur are as follows:

1. The manifest.json file will be validated
1. The router folder will be deleted and recreated to remove any lingering files from previous runs
1. All applicable GTFS, OSM and OTP jar files will be downloaded asynchronously
1. OTP will build a Graph
1. OTP will be ran as a server

### Downloading/Uploading to AWS S3

It is possible to download files from AWS S3 as long as the proper AWS S3 url is included. For example, if you wanted to download a GTFS file from s3 you could specify: `s3://example-bucket/gtfs.zip`. If any of the `upload*` parameters are set, the `s3UploadPath` must also be provided. Also, the `aws` command line tool and proper credentials to upload to AWS S3 must be setup in order for this script to properly upload files.

### Manifest.json values

*The rest of this README contains auto-generated contents via the `yarn update-readme` script and should not be directly edited!*

| Key | Type | Required | Default | Description |
| - | - | - | - | - |
| buildConfigJSON | string | Optional | | The raw contents to write to the build-config.json file. |
| buildGraph | boolean | Optional | true | If true, run OpenTripPlanner in build mode |
| buildLogFile | string | Optional | /var/log/otp-build.log | The path where the build logs should be written to. |
| graphObjUrl | string | Optional | | A url where the Graph.obj should be downloaded from for server-only runs. If `uploadGraph` is set to true, this value must be an s3 url that can be uploaded to. |
| graphsFolder | string | Optional | /var/otp/graphs | The folder where the graphs should be stored. |
| gtfsAndOsmUrls | array | Optional | | An array of GTFS and OSM urls that should be downloaded. |
| jarFile | string | Optional | /opt/otp-1.4.0-shaded.jar | The full path to the OTP jar file. |
| jarUrl | string | Optional | https://repo1.maven.org/maven2/org/opentripplanner/otp/1.4.0/otp-1.4.0-shaded.jar | A url where the OTP jar can be downloaded from. |
| otpRunnerLogFile | string | Optional | /var/log/otp-runner.log | The path where the otp-runner logs should be written to. |
| prefixLogUploadsWithInstanceId | boolean | Optional | false | If true, will obtain the ec2 instance ID and prefix the otp-runner and otp-server log files with this instance ID when uploading to s3. |
| routerConfigJSON | string | Optional | | The raw contents to write to the router-config.json file. |
| routerName | string | Optional | default | The name of the OTP router. |
| runServer | boolean | Optional | true | If true, run OTP as a server. |
| s3UploadPath | string | Optional | | The base path of an s3 bucket where files will be uploaded to. Ex: `s3://path/to/folder` |
| serverLogFile | string | Optional | /var/log/otp-server.log | The file location to write server logs to. |
| serverStartupTimeoutSeconds | number | Optional | 300 | The amount of time to wait for a successful server startup (server initialization and graph read) before failing. |
| statusFileLocation | string | Optional | status.json | The file location to write status updates about this script to. |
| uploadGraphBuildLogs | boolean | Optional | false | If true, the logs from a graph build will be uploaded to the provided s3 bucket to the path `${s3UploadPath}/otp-build.log`. Note: if this is set to true, `s3UploadPath` must be defined. |
| uploadGraphBuildReport | boolean | Optional | false | If true, the OTP-generated graph build report will be zipped up and uploaded to the provided s3 bucket to the path `${s3UploadPath}/graph-build-report.zip`. Note: if this is set to true, `s3UploadPath` must be defined. |
| uploadGraph | boolean | Optional | false | If true, the Graph.obj file will be uploaded after graph build. Note: if this is set to true, `graphObjUrl` must be defined and be a valid AWS s3 path. |
| uploadOtpRunnerLogs | boolean | Optional | false | If true, the logs from the otp-runner script will be uploaded to the provided s3 bucket to the path `${s3UploadPath}/otp-runner.log`. Note: if this is set to true, `s3UploadPath` must be defined. |
| uploadServerStartupLogs | boolean | Optional | false | If true, the logs from the server startup will be uploaded to the provided s3 bucket to the path `${s3UploadPath}/otp-server.log`. Note: if this is set to true, `s3UploadPath` must be defined. |
