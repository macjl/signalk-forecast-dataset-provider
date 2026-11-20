# Forecast Dataset Provider roadmap

## Support new catalogue workflows

- [ ] Use the existing publication API for GRIB imports from the [Forecast Dataset Browser](https://github.com/macjl/signalk-forecast-dataset-browser). Keep the uploaded bytes as original assets and make the completed run discoverable alongside automatic downloads.
- [ ] Publish lower-resolution exports from [GRIB Processor](https://github.com/macjl/signalk-grib-processor) as derived datasets. Record the source version and output resolution so clients can identify both representations.
- [ ] Verify direct discovery and access for [Weather Map](https://github.com/macjl/signalk-weather-map), including selection by model and run for forecast comparisons.
