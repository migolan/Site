﻿using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using GeoAPI.Geometries;
using IsraelHiking.API.Executors;
using IsraelHiking.Common;
using IsraelHiking.DataAccessInterfaces;
using Microsoft.Extensions.Options;
using NetTopologySuite.Features;
using NetTopologySuite.Geometries;
using OsmSharp;
using OsmSharp.Complete;
using OsmSharp.Tags;

namespace IsraelHiking.API.Services.Poi
{
    /// <summary>
    /// Points of interest adapter for OSM data
    /// </summary>
    public class OsmPointsOfInterestAdapter : BasePointsOfInterestAdapter, IPointsOfInterestAdapter
    {
        private readonly IElasticSearchGateway _elasticSearchGateway;
        private readonly IHttpGatewayFactory _httpGatewayFactory;
        private readonly IOsmGeoJsonPreprocessorExecutor _osmGeoJsonPreprocessorExecutor;
        private readonly IOsmRepository _osmRepository;
        private readonly ConfigurationData _options;

        /// <summary>
        /// Adapter's constructor
        /// </summary>
        /// <param name="elasticSearchGateway"></param>
        /// <param name="elevationDataStorage"></param>
        /// <param name="httpGatewayFactory"></param>
        /// <param name="osmGeoJsonPreprocessorExecutor"></param>
        /// <param name="osmRepository"></param>
        /// <param name="options"></param>
        public OsmPointsOfInterestAdapter(IElasticSearchGateway elasticSearchGateway,
            IElevationDataStorage elevationDataStorage,
            IHttpGatewayFactory httpGatewayFactory,
            IOsmGeoJsonPreprocessorExecutor osmGeoJsonPreprocessorExecutor,
            IOsmRepository osmRepository,
            IOptions<ConfigurationData> options) : base(elevationDataStorage, elasticSearchGateway)
        {
            _elasticSearchGateway = elasticSearchGateway;
            _httpGatewayFactory = httpGatewayFactory;
            _osmGeoJsonPreprocessorExecutor = osmGeoJsonPreprocessorExecutor;
            _osmRepository = osmRepository;
            _options = options.Value;
        }
        /// <inheritdoc />
        public string Source => Sources.OSM;

        /// <inheritdoc />
        public async Task<PointOfInterest[]> GetPointsOfInterest(Coordinate northEast, Coordinate southWest, string[] categories, string language)
        {
            var features = await _elasticSearchGateway.GetPointsOfInterest(northEast, southWest, categories);
            return await Task.WhenAll(features.Select(f => ConvertToPoiItem<PointOfInterest>(f, language)));
        }

        /// <inheritdoc />
        public async Task<PointOfInterestExtended> GetPointOfInterestById(string id, string language)
        {
            var feature = await _elasticSearchGateway.GetPointOfInterestById(id, Sources.OSM);
            var poiItem = await ConvertToPoiItem<PointOfInterestExtended>(feature, language);
            await AddExtendedData(poiItem, feature, language);
            return poiItem;
        }

        /// <inheritdoc />
        public async Task AddPointOfInterest(PointOfInterestExtended pointOfInterest, TokenAndSecret tokenAndSecret, string language)
        {
            var osmGateway = _httpGatewayFactory.CreateOsmGateway(tokenAndSecret);
            var changesetId = await osmGateway.CreateChangeset("Add POI interface from IHM site.");
            var node = new Node
            {
                Latitude = pointOfInterest.Location.lat,
                Longitude = pointOfInterest.Location.lng,
                Tags = new TagsCollection
                {
                    {FeatureAttributes.IMAGE_URL, pointOfInterest.ImageUrl},
                    {FeatureAttributes.WEBSITE, pointOfInterest.Url}
                }
            };
            SetTagByLanguage(node.Tags, FeatureAttributes.NAME, pointOfInterest.Title, language);
            SetTagByLanguage(node.Tags, FeatureAttributes.DESCRIPTION, pointOfInterest.Description, language);
            UpdateTagsByIcon(node.Tags, pointOfInterest.Icon);
            RemoveEmptyTags(node.Tags);
            var id = await osmGateway.CreateElement(changesetId, node);
            node.Id = long.Parse(id);
            await osmGateway.CloseChangeset(changesetId);

            await UpdateElasticSearch(node, pointOfInterest.Title);
        }

        /// <inheritdoc />
        public async Task UpdatePointOfInterest(PointOfInterestExtended pointOfInterest, TokenAndSecret tokenAndSecret, string language)
        {
            var osmGateway = _httpGatewayFactory.CreateOsmGateway(tokenAndSecret);

            var feature = await _elasticSearchGateway.GetPointOfInterestById(pointOfInterest.Id, Sources.OSM);
            var id = pointOfInterest.Id;
            ICompleteOsmGeo completeOsmGeo;
            if (feature.Geometry is Point)
            {
                completeOsmGeo = await osmGateway.GetNode(id);
            }
            else if (feature.Geometry is LineString || feature.Geometry is Polygon)
            {
                completeOsmGeo = await osmGateway.GetCompleteWay(id);
            }
            else
            {
                completeOsmGeo = await osmGateway.GetCompleteRelation(id);
            }
            SetTagByLanguage(completeOsmGeo.Tags, FeatureAttributes.NAME, pointOfInterest.Description, language);
            SetTagByLanguage(completeOsmGeo.Tags, FeatureAttributes.DESCRIPTION, pointOfInterest.Description, language);
            completeOsmGeo.Tags[FeatureAttributes.IMAGE_URL] = pointOfInterest.ImageUrl;
            completeOsmGeo.Tags[FeatureAttributes.WEBSITE] = pointOfInterest.Url;
            if (pointOfInterest.Icon != feature.Attributes[FeatureAttributes.ICON].ToString())
            {
                // HM TODO: tag to icon mapping needed.
                UpdateTagsByIcon(completeOsmGeo.Tags, pointOfInterest.Icon);
            }
            RemoveEmptyTags(completeOsmGeo.Tags);
            var changesetId = await osmGateway.CreateChangeset("Update POI interface from IHM site.");
            await osmGateway.UpdateElement(changesetId, completeOsmGeo);
            await osmGateway.CloseChangeset(changesetId);

            await UpdateElasticSearch(completeOsmGeo, pointOfInterest.Title);
        }

        /// <inheritdoc />
        public async Task<List<Feature>> GetPointsForIndexing(Stream memoryStream)
        {
            var osmNamesDictionary = await _osmRepository.GetElementsWithName(memoryStream);
            var geoJsonNamesDictionary = _osmGeoJsonPreprocessorExecutor.Preprocess(osmNamesDictionary);
            return geoJsonNamesDictionary.Values.SelectMany(v => v).ToList();
        }

        private async Task UpdateElasticSearch(ICompleteOsmGeo osm, string name)
        {
            var features = _osmGeoJsonPreprocessorExecutor.Preprocess(
                new Dictionary<string, List<ICompleteOsmGeo>>
                {
                    {name, new List<ICompleteOsmGeo> {osm}}
                });
            var feature = features.Values.FirstOrDefault()?.FirstOrDefault();
            if (feature != null)
            {
                await _elasticSearchGateway.UpdateNamesData(feature);
            }
        }

        private void SetTagByLanguage(TagsCollectionBase tags, string key, string value, string language)
        {
            language = GetLanguage(value, language);
            if (language == _options.DefaultLanguage)
            {
                if (tags.ContainsKey(key))
                {
                    tags[key] = value;
                    return;
                }
                tags.Add(new Tag(key, value));
            }
            var keyWithLanguage = key + ":" + language;
            if (tags.ContainsKey(keyWithLanguage))
            {
                tags[keyWithLanguage] = value;
                return;
            }
            tags.Add(new Tag(keyWithLanguage, value));
        }

        private string GetLanguage(string value, string language)
        {
            if (string.IsNullOrWhiteSpace(value))
            {
                return language;
            }
            language = "he";
            if (HasHebrewCharacters(value) == false)
            {
                language = "en";
            }
            return language;
        }

        private bool HasHebrewCharacters(string words)
        {
            return Regex.Match(words, @"^[^a-zA-Z]*[\u0591-\u05F4]").Success;
        }

        private void UpdateTagsByIcon(TagsCollectionBase tags, string icon)
        {
            switch (icon)
            {
                case "icon-viewpoint":
                    tags.Add("tourism", "viewpoint");
                    break;
                case "icon-tint":
                    tags.Add("natural", "spring");
                    break;
                case "icon-ruins":
                    tags.Add("historic", "ruins");
                    break;
                case "icon-picnic":
                    tags.Add("tourism", "picnic_site");
                    break;
                case "icon-campsite":
                    tags.Add("tourism", "camp_site");
                    break;
                case "icon-tree":
                    tags.Add("natural", "tree");
                    break;
                case "icon-cave":
                    tags.Add("natural", "cave_entrance");
                    break;
                case "icon-star":
                    tags.Add("tourism", "attraction");
                    break;
                case "icon-peak":
                    tags.Add("natural", "peak");
                    break;
            }
        }

        private void RemoveEmptyTags(TagsCollectionBase tags)
        {
            for (int i = tags.Count - 1; i >= 0; i--)
            {
                var currentTag = tags.ElementAt(i);
                if (string.IsNullOrWhiteSpace(currentTag.Value))
                {
                    tags.RemoveKeyValue(currentTag);
                }
            }
        }
    }
}