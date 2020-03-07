﻿using IsraelHiking.Common;
using IsraelHiking.DataAccessInterfaces;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Options;
using System;
using System.Collections.Generic;
using System.IO;
using System.Threading.Tasks;

namespace IsraelHiking.API.Services
{
    /// <inheritdoc/>
    public class OfflineFilesService : IOfflineFilesService
    {
        private readonly PhysicalFileProvider _fileProvider;
        private readonly IFileSystemHelper _fileSystemHelper;
        private readonly IReceiptValidationGateway _receiptValidationGateway;

        /// <summary>
        /// Constructor
        /// </summary>
        /// <param name="fileSystemHelper"></param>
        /// <param name="receiptValidationGateway"></param>
        /// <param name="options"></param>
        public OfflineFilesService(IFileSystemHelper fileSystemHelper,
            IReceiptValidationGateway receiptValidationGateway,
            IOptions<NonPublicConfigurationData> options)
        {
            _fileProvider = new PhysicalFileProvider(options.Value.OfflineFilesFolder);
            _fileSystemHelper = fileSystemHelper;
            _receiptValidationGateway = receiptValidationGateway;
        }

        /// <inheritdoc/>
        public async Task<List<string>> GetUpdatedFilesList(string userId, DateTime lastModifiedDate)
        {
            var filesList = new List<string>();
            if (!await _receiptValidationGateway.IsEntitled(userId))
            {
                return new List<string>();
            }
            var contents = _fileProvider.GetDirectoryContents(string.Empty);
            foreach (var content in contents)
            {
                if (_fileSystemHelper.IsHidden(content.PhysicalPath))
                {
                    continue;
                }
                if (lastModifiedDate == DateTime.MinValue || content.LastModified > lastModifiedDate)
                {
                    filesList.Add(content.Name);
                }
            }
            return filesList;
        }

        /// <inheritdoc/>
        public async Task<Stream> GetFileContent(string userId, string fileName)
        {
            if (!await _receiptValidationGateway.IsEntitled(userId))
            {
                return null;
            }
            return _fileProvider.GetFileInfo(fileName).CreateReadStream();
        }
    }
}